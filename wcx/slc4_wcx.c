/* SLC4 packer plugin for Total Commander (.wcx64).
 *
 * The plugin knows nothing about the SLC4 format. It drives slc4.exe, which
 * must sit next to the plugin DLL, so the codec stays in exactly one place and
 * the archives Total Commander shows are the same ones the CLI and the web app
 * produce.
 *
 * A .slc4z holds one document rather than a file tree, so an archive is
 * presented as two entries:
 *
 *   <name>.json              the decoded payload
 *   <name>.slc4-report.txt   inspect output: codec chosen per column
 *
 * The report makes F3 on an archive immediately useful -- it answers "why is
 * it this size" without unpacking anything.
 *
 * Opening an archive decodes it once into a temporary directory; listing and
 * extracting then read from there, and CloseArchive removes it.
 */

#include "wcxhead.h"
#include <stdio.h>
#include <wchar.h>

#define ENTRY_PAYLOAD 0
#define ENTRY_REPORT  1
#define ENTRY_COUNT   2

typedef struct {
    wchar_t     name[MAX_PATH];   /* what Total Commander shows */
    wchar_t     path[MAX_PATH];   /* the extracted temporary file */
    ULONGLONG   size;
} tEntry;

typedef struct {
    wchar_t           arcName[MAX_PATH];
    wchar_t           tempDir[MAX_PATH];
    tEntry            entries[ENTRY_COUNT];
    int               cursor;
    ULONGLONG         archiveSize;
    FILETIME          archiveTime;
    tProcessDataProcW progressW;
    tProcessDataProc  progressA;
} tArchive;

static HMODULE g_module = NULL;

BOOL WINAPI DllMain(HINSTANCE hInst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        g_module = (HMODULE)hInst;
        DisableThreadLibraryCalls(hInst);
    }
    return TRUE;
}

/* ---------------------------------------------------------------- helpers -- */

/* slc4.exe is looked up next to the plugin so a copied plugin folder is
 * self-contained; PATH is only a fallback. */
static BOOL locateTool(wchar_t *out, size_t cch)
{
    wchar_t self[MAX_PATH];
    DWORD n = GetModuleFileNameW(g_module, self, MAX_PATH);
    if (n > 0 && n < MAX_PATH) {
        wchar_t *slash = wcsrchr(self, L'\\');
        if (slash) {
            *(slash + 1) = L'\0';
            _snwprintf(out, cch, L"%s%s", self, L"slc4.exe");
            out[cch - 1] = L'\0';
            if (GetFileAttributesW(out) != INVALID_FILE_ATTRIBUTES) return TRUE;
        }
    }
    wcsncpy(out, L"slc4.exe", cch);
    out[cch - 1] = L'\0';
    return SearchPathW(NULL, L"slc4.exe", NULL, 0, NULL, NULL) > 0;
}

/* Runs a command line with stdout sent to hOut (which may be INVALID_HANDLE_VALUE)
 * and stderr discarded. Returns TRUE when the process exits with code 0. */
static BOOL runProcess(const wchar_t *cmdLine, HANDLE hOut)
{
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    SECURITY_ATTRIBUTES sa;
    HANDLE hNul;
    wchar_t *mutable;
    size_t len;
    DWORD exitCode = 1;
    BOOL ok;

    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;
    hNul = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                       &sa, OPEN_EXISTING, 0, NULL);

    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdInput = NULL;
    si.hStdOutput = (hOut != INVALID_HANDLE_VALUE) ? hOut : hNul;
    si.hStdError = hNul;

    /* CreateProcessW may modify the command line, so it cannot be a literal. */
    len = wcslen(cmdLine) + 1;
    mutable = (wchar_t *)malloc(len * sizeof(wchar_t));
    if (!mutable) { if (hNul != INVALID_HANDLE_VALUE) CloseHandle(hNul); return FALSE; }
    wcscpy(mutable, cmdLine);

    ZeroMemory(&pi, sizeof(pi));
    ok = CreateProcessW(NULL, mutable, NULL, NULL, TRUE,
                        CREATE_NO_WINDOW, NULL, NULL, &si, &pi);
    free(mutable);
    if (hNul != INVALID_HANDLE_VALUE) CloseHandle(hNul);
    if (!ok) return FALSE;

    WaitForSingleObject(pi.hProcess, INFINITE);
    GetExitCodeProcess(pi.hProcess, &exitCode);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return exitCode == 0;
}

/* Runs a command line and collects its stdout as UTF-8 text. */
static BOOL runCapture(const wchar_t *cmdLine, char *out, size_t size)
{
    SECURITY_ATTRIBUTES sa;
    HANDLE hRead = NULL, hWrite = NULL;
    DWORD got = 0;
    size_t total = 0;
    BOOL ok;

    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;
    if (!CreatePipe(&hRead, &hWrite, &sa, 0)) return FALSE;
    SetHandleInformation(hRead, HANDLE_FLAG_INHERIT, 0);

    ok = runProcess(cmdLine, hWrite);
    CloseHandle(hWrite);  /* the child holds the only other end; close to see EOF */

    while (total + 1 < size && ReadFile(hRead, out + total, (DWORD)(size - total - 1), &got, NULL) && got > 0)
        total += got;
    out[total] = '\0';
    CloseHandle(hRead);
    return ok;
}

static BOOL runToFile(const wchar_t *cmdLine, const wchar_t *path)
{
    SECURITY_ATTRIBUTES sa;
    HANDLE hFile;
    BOOL ok;

    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;
    hFile = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, &sa,
                        CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) return FALSE;
    ok = runProcess(cmdLine, hFile);
    CloseHandle(hFile);
    return ok;
}

static ULONGLONG fileSize(const wchar_t *path)
{
    WIN32_FILE_ATTRIBUTE_DATA fad;
    if (!GetFileAttributesExW(path, GetFileExInfoStandard, &fad)) return 0;
    return ((ULONGLONG)fad.nFileSizeHigh << 32) | fad.nFileSizeLow;
}

static void fileStat(const wchar_t *path, ULONGLONG *size, FILETIME *mtime)
{
    WIN32_FILE_ATTRIBUTE_DATA fad;
    if (GetFileAttributesExW(path, GetFileExInfoStandard, &fad)) {
        *size = ((ULONGLONG)fad.nFileSizeHigh << 32) | fad.nFileSizeLow;
        *mtime = fad.ftLastWriteTime;
    } else {
        *size = 0;
        ZeroMemory(mtime, sizeof(*mtime));
    }
}

static int dosTime(FILETIME ft)
{
    FILETIME local;
    WORD date = 0, time = 0;
    if (!FileTimeToLocalFileTime(&ft, &local)) return 0;
    if (!FileTimeToDosDateTime(&local, &date, &time)) return 0;
    return ((int)date << 16) | time;
}

static BOOL makeTempDir(wchar_t *out, size_t cch)
{
    wchar_t base[MAX_PATH];
    static LONG counter = 0;
    DWORD n = GetTempPathW(MAX_PATH, base);
    if (n == 0 || n >= MAX_PATH) return FALSE;
    _snwprintf(out, cch, L"%sslc4wcx_%lu_%lu", base,
               (unsigned long)GetCurrentProcessId(),
               (unsigned long)InterlockedIncrement(&counter));
    out[cch - 1] = L'\0';
    return CreateDirectoryW(out, NULL) || GetLastError() == ERROR_ALREADY_EXISTS;
}

static void removeTempDir(const wchar_t *dir)
{
    wchar_t pattern[MAX_PATH], full[MAX_PATH];
    WIN32_FIND_DATAW fd;
    HANDLE h;
    if (!dir[0]) return;
    _snwprintf(pattern, MAX_PATH, L"%s\\*", dir);
    pattern[MAX_PATH - 1] = L'\0';
    h = FindFirstFileW(pattern, &fd);
    if (h != INVALID_HANDLE_VALUE) {
        do {
            if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
            _snwprintf(full, MAX_PATH, L"%s\\%s", dir, fd.cFileName);
            full[MAX_PATH - 1] = L'\0';
            DeleteFileW(full);
        } while (FindNextFileW(h, &fd));
        FindClose(h);
    }
    RemoveDirectoryW(dir);
}

static void stemOf(const wchar_t *path, wchar_t *out, size_t cch)
{
    const wchar_t *base = wcsrchr(path, L'\\');
    wchar_t *dot;
    base = base ? base + 1 : path;
    wcsncpy(out, base, cch);
    out[cch - 1] = L'\0';
    dot = wcsrchr(out, L'.');
    if (dot && dot != out) *dot = L'\0';
}

/* --------------------------------------------------------------- open/list -- */

static HANDLE openArchive(const wchar_t *arcName, int openMode, int *openResult)
{
    wchar_t tool[MAX_PATH], cmd[MAX_PATH * 3], stem[MAX_PATH];
    char line[1024];
    tArchive *a;
    char *tab;
    (void)openMode;

    if (!locateTool(tool, MAX_PATH)) { *openResult = E_EOPEN; return NULL; }

    a = (tArchive *)calloc(1, sizeof(tArchive));
    if (!a) { *openResult = E_NO_MEMORY; return NULL; }

    wcsncpy(a->arcName, arcName, MAX_PATH - 1);
    fileStat(arcName, &a->archiveSize, &a->archiveTime);

    if (!makeTempDir(a->tempDir, MAX_PATH)) { free(a); *openResult = E_ECREATE; return NULL; }

    _snwprintf(a->entries[ENTRY_PAYLOAD].path, MAX_PATH, L"%s\\payload", a->tempDir);
    _snwprintf(a->entries[ENTRY_REPORT].path, MAX_PATH, L"%s\\report.txt", a->tempDir);

    /* --porcelain reports the document's original name and size on stdout, so
     * the entry can be labelled without the plugin parsing the archive. */
    _snwprintf(cmd, MAX_PATH * 3, L"\"%s\" unpack \"%s\" -o \"%s\" --porcelain -q",
               tool, arcName, a->entries[ENTRY_PAYLOAD].path);
    cmd[MAX_PATH * 3 - 1] = L'\0';
    if (!runCapture(cmd, line, sizeof(line))) {
        removeTempDir(a->tempDir);
        free(a);
        *openResult = E_BAD_ARCHIVE;
        return NULL;
    }

    tab = strchr(line, '\t');
    if (tab) {
        *tab = '\0';
        MultiByteToWideChar(CP_UTF8, 0, line, -1, a->entries[ENTRY_PAYLOAD].name, MAX_PATH);
    } else {
        stemOf(arcName, stem, MAX_PATH);
        _snwprintf(a->entries[ENTRY_PAYLOAD].name, MAX_PATH, L"%s.json", stem);
    }
    a->entries[ENTRY_PAYLOAD].name[MAX_PATH - 1] = L'\0';
    a->entries[ENTRY_PAYLOAD].size = fileSize(a->entries[ENTRY_PAYLOAD].path);

    stemOf(arcName, stem, MAX_PATH);
    _snwprintf(a->entries[ENTRY_REPORT].name, MAX_PATH, L"%s.slc4-report.txt", stem);
    a->entries[ENTRY_REPORT].name[MAX_PATH - 1] = L'\0';
    _snwprintf(cmd, MAX_PATH * 3, L"\"%s\" inspect \"%s\"", tool, arcName);
    cmd[MAX_PATH * 3 - 1] = L'\0';
    runToFile(cmd, a->entries[ENTRY_REPORT].path);   /* advisory: absence is not fatal */
    a->entries[ENTRY_REPORT].size = fileSize(a->entries[ENTRY_REPORT].path);

    a->cursor = 0;
    *openResult = E_SUCCESS;
    return (HANDLE)a;
}

__declspec(dllexport) HANDLE __stdcall OpenArchiveW(tOpenArchiveDataW *data)
{
    HANDLE h;
    if (!data) return NULL;
    h = openArchive(data->ArcName, data->OpenMode, &data->OpenResult);
    return h;
}

__declspec(dllexport) HANDLE __stdcall OpenArchive(tOpenArchiveData *data)
{
    wchar_t wide[MAX_PATH];
    if (!data) return NULL;
    MultiByteToWideChar(CP_ACP, 0, data->ArcName, -1, wide, MAX_PATH);
    return openArchive(wide, data->OpenMode, &data->OpenResult);
}

__declspec(dllexport) int __stdcall ReadHeaderExW(HANDLE hArcData, tHeaderDataExW *header)
{
    tArchive *a = (tArchive *)hArcData;
    tEntry *e;
    if (!a || !header) return E_BAD_ARCHIVE;
    if (a->cursor >= ENTRY_COUNT) return E_END_ARCHIVE;
    e = &a->entries[a->cursor];
    if (e->size == 0 && a->cursor == ENTRY_REPORT) return E_END_ARCHIVE;  /* inspect produced nothing */

    ZeroMemory(header, sizeof(*header));
    wcsncpy(header->ArcName, a->arcName, 1023);
    wcsncpy(header->FileName, e->name, 1023);
    header->UnpSize = (unsigned int)(e->size & 0xffffffffULL);
    header->UnpSizeHigh = (unsigned int)(e->size >> 32);
    /* The container is one compressed stream, so per-entry packed size is not
     * meaningful; the payload is credited with the whole archive. */
    if (a->cursor == ENTRY_PAYLOAD) {
        header->PackSize = (unsigned int)(a->archiveSize & 0xffffffffULL);
        header->PackSizeHigh = (unsigned int)(a->archiveSize >> 32);
    }
    header->FileTime = dosTime(a->archiveTime);
    header->FileAttr = FILE_ATTRIBUTE_NORMAL;
    header->HostOS = 0;
    header->Method = 0;
    header->UnpVer = 1;
    return E_SUCCESS;
}

__declspec(dllexport) int __stdcall ReadHeaderEx(HANDLE hArcData, tHeaderDataEx *header)
{
    tHeaderDataExW w;
    int rc = ReadHeaderExW(hArcData, &w);
    if (rc != E_SUCCESS) return rc;
    ZeroMemory(header, sizeof(*header));
    WideCharToMultiByte(CP_ACP, 0, w.ArcName, -1, header->ArcName, 1024, NULL, NULL);
    WideCharToMultiByte(CP_ACP, 0, w.FileName, -1, header->FileName, 1024, NULL, NULL);
    header->UnpSize = w.UnpSize;
    header->UnpSizeHigh = w.UnpSizeHigh;
    header->PackSize = w.PackSize;
    header->PackSizeHigh = w.PackSizeHigh;
    header->FileTime = w.FileTime;
    header->FileAttr = w.FileAttr;
    header->UnpVer = w.UnpVer;
    return E_SUCCESS;
}

__declspec(dllexport) int __stdcall ReadHeader(HANDLE hArcData, tHeaderData *header)
{
    tHeaderDataExW w;
    int rc = ReadHeaderExW(hArcData, &w);
    if (rc != E_SUCCESS) return rc;
    ZeroMemory(header, sizeof(*header));
    WideCharToMultiByte(CP_ACP, 0, w.ArcName, -1, header->ArcName, 260, NULL, NULL);
    WideCharToMultiByte(CP_ACP, 0, w.FileName, -1, header->FileName, 260, NULL, NULL);
    header->UnpSize = (int)w.UnpSize;
    header->PackSize = (int)w.PackSize;
    header->FileTime = w.FileTime;
    header->FileAttr = w.FileAttr;
    header->UnpVer = w.UnpVer;
    return E_SUCCESS;
}

/* ---------------------------------------------------------------- extract -- */

/* Copied in chunks so Total Commander's progress bar advances and the user can
 * abort a large extraction. */
static int copyWithProgress(tArchive *a, const wchar_t *from, const wchar_t *to)
{
    HANDLE in, out;
    BYTE buffer[64 * 1024];
    DWORD got = 0, put = 0;
    int aborted = 0;

    in = CreateFileW(from, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (in == INVALID_HANDLE_VALUE) return E_EOPEN;
    out = CreateFileW(to, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (out == INVALID_HANDLE_VALUE) { CloseHandle(in); return E_ECREATE; }

    while (ReadFile(in, buffer, sizeof(buffer), &got, NULL) && got > 0) {
        if (!WriteFile(out, buffer, got, &put, NULL) || put != got) {
            CloseHandle(in); CloseHandle(out);
            return E_EWRITE;
        }
        if (a->progressW && a->progressW(NULL, (int)got) == 0) { aborted = 1; break; }
        if (!a->progressW && a->progressA && a->progressA(NULL, (int)got) == 0) { aborted = 1; break; }
    }
    CloseHandle(in);
    CloseHandle(out);
    if (aborted) { DeleteFileW(to); return E_EABORTED; }
    return E_SUCCESS;
}

static int processFile(HANDLE hArcData, int operation, const wchar_t *destPath, const wchar_t *destName)
{
    tArchive *a = (tArchive *)hArcData;
    wchar_t target[MAX_PATH * 2];
    tEntry *e;
    int rc = E_SUCCESS;

    if (!a) return E_BAD_ARCHIVE;
    if (a->cursor >= ENTRY_COUNT) return E_END_ARCHIVE;
    e = &a->entries[a->cursor];

    if (operation == PK_EXTRACT) {
        if (destPath && destPath[0] && destName)
            _snwprintf(target, MAX_PATH * 2, L"%s%s", destPath, destName);
        else if (destName)
            wcsncpy(target, destName, MAX_PATH * 2 - 1);
        else
            return E_ECREATE;
        target[MAX_PATH * 2 - 1] = L'\0';
        rc = copyWithProgress(a, e->path, target);
    }
    /* PK_TEST is satisfied by OpenArchive already having decoded the archive;
     * PK_SKIP needs nothing. */

    a->cursor++;
    return rc;
}

__declspec(dllexport) int __stdcall ProcessFileW(HANDLE hArcData, int operation, WCHAR *destPath, WCHAR *destName)
{
    return processFile(hArcData, operation, destPath, destName);
}

__declspec(dllexport) int __stdcall ProcessFile(HANDLE hArcData, int operation, char *destPath, char *destName)
{
    wchar_t wPath[MAX_PATH] = L"", wName[MAX_PATH] = L"";
    if (destPath) MultiByteToWideChar(CP_ACP, 0, destPath, -1, wPath, MAX_PATH);
    if (destName) MultiByteToWideChar(CP_ACP, 0, destName, -1, wName, MAX_PATH);
    return processFile(hArcData, operation, destPath ? wPath : NULL, destName ? wName : NULL);
}

__declspec(dllexport) int __stdcall CloseArchive(HANDLE hArcData)
{
    tArchive *a = (tArchive *)hArcData;
    if (!a) return E_SUCCESS;
    removeTempDir(a->tempDir);
    free(a);
    return E_SUCCESS;
}

__declspec(dllexport) void __stdcall SetChangeVolProc(HANDLE hArcData, tChangeVolProc proc)
{
    (void)hArcData; (void)proc;   /* single-volume format */
}

__declspec(dllexport) void __stdcall SetChangeVolProcW(HANDLE hArcData, tChangeVolProcW proc)
{
    (void)hArcData; (void)proc;
}

__declspec(dllexport) void __stdcall SetProcessDataProc(HANDLE hArcData, tProcessDataProc proc)
{
    tArchive *a = (tArchive *)hArcData;
    if (a) a->progressA = proc;
}

__declspec(dllexport) void __stdcall SetProcessDataProcW(HANDLE hArcData, tProcessDataProcW proc)
{
    tArchive *a = (tArchive *)hArcData;
    if (a) a->progressW = proc;
}

/* ------------------------------------------------------------------- pack -- */

__declspec(dllexport) int __stdcall GetPackerCaps(void)
{
    /* New archives only. Deliberately no PK_CAPS_MULTIPLE (a .slc4z holds one
     * document), no PK_CAPS_MODIFY (the container is a single stream) and no
     * PK_CAPS_BY_CONTENT -- content detection would see a bare Zstandard frame
     * and wrongly claim every .zst file on the system. */
    return PK_CAPS_NEW;
}

static int packFiles(const wchar_t *packedFile, const wchar_t *srcPath, const wchar_t *addList)
{
    wchar_t tool[MAX_PATH], cmd[MAX_PATH * 4], source[MAX_PATH * 2];
    const wchar_t *first = addList;

    if (!packedFile || !addList || !addList[0]) return E_NO_FILES;
    /* AddList is a double-null-terminated sequence; a second entry means the
     * user selected more than one file, which this format cannot represent. */
    if (first[wcslen(first) + 1] != L'\0') return E_TOO_MANY_FILES;
    if (!locateTool(tool, MAX_PATH)) return E_EOPEN;

    if (srcPath && srcPath[0])
        _snwprintf(source, MAX_PATH * 2, L"%s%s", srcPath, first);
    else
        wcsncpy(source, first, MAX_PATH * 2 - 1);
    source[MAX_PATH * 2 - 1] = L'\0';

    _snwprintf(cmd, MAX_PATH * 4, L"\"%s\" pack \"%s\" -o \"%s\" -q", tool, source, packedFile);
    cmd[MAX_PATH * 4 - 1] = L'\0';

    if (!runProcess(cmd, INVALID_HANDLE_VALUE)) {
        DeleteFileW(packedFile);
        return E_BAD_DATA;   /* not valid JSON, or the round-trip check failed */
    }
    return E_SUCCESS;
}

__declspec(dllexport) int __stdcall PackFilesW(WCHAR *packedFile, WCHAR *subPath, WCHAR *srcPath, WCHAR *addList, int flags)
{
    (void)subPath; (void)flags;
    return packFiles(packedFile, srcPath, addList);
}

__declspec(dllexport) int __stdcall PackFiles(char *packedFile, char *subPath, char *srcPath, char *addList, int flags)
{
    wchar_t wPacked[MAX_PATH] = L"", wSrc[MAX_PATH] = L"", wList[MAX_PATH * 2];
    size_t len;
    (void)subPath; (void)flags;
    if (!packedFile || !addList) return E_NO_FILES;
    MultiByteToWideChar(CP_ACP, 0, packedFile, -1, wPacked, MAX_PATH);
    if (srcPath) MultiByteToWideChar(CP_ACP, 0, srcPath, -1, wSrc, MAX_PATH);
    len = MultiByteToWideChar(CP_ACP, 0, addList, -1, wList, MAX_PATH * 2 - 1);
    wList[len] = L'\0';   /* keep the double-null terminator intact */
    return packFiles(wPacked, wSrc, wList);
}

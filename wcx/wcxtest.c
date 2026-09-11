/* Test host for the SLC4 packer plugin.
 *
 * Loads slc4.wcx64 and drives it exactly the way Total Commander does --
 * open, enumerate, extract, close, then pack -- so the plugin can be verified
 * without a running Total Commander.
 *
 *   wcxtest.exe <plugin.wcx64> <archive.slc4z> <reference.json> <workdir>
 *
 * <reference.json> is the output of `slc4 unpack` for the same archive. The
 * plugin must hand Total Commander exactly those bytes. Comparing against the
 * document as it looked before packing would be wrong: SLC4 preserves JSON
 * values, not JSON key order, so the text is not expected to match byte for byte.
 *
 * Exit code 0 means every step behaved.
 */

#include "wcxhead.h"
#include <stdio.h>
#include <wchar.h>

typedef HANDLE (__stdcall *fnOpenArchiveW)(tOpenArchiveDataW *);
typedef int    (__stdcall *fnReadHeaderExW)(HANDLE, tHeaderDataExW *);
typedef int    (__stdcall *fnProcessFileW)(HANDLE, int, WCHAR *, WCHAR *);
typedef int    (__stdcall *fnCloseArchive)(HANDLE);
typedef int    (__stdcall *fnGetPackerCaps)(void);
typedef int    (__stdcall *fnPackFilesW)(WCHAR *, WCHAR *, WCHAR *, WCHAR *, int);
typedef void   (__stdcall *fnSetProcessDataProcW)(HANDLE, tProcessDataProcW);

static int failures = 0;
static ULONGLONG progressBytes = 0;

static void ok(const char *what, int condition, const char *detail)
{
    if (condition) {
        printf("  ok    %s\n", what);
    } else {
        printf("  FAIL  %s%s%s\n", what, detail ? " -- " : "", detail ? detail : "");
        failures++;
    }
}

static int __stdcall onProgress(WCHAR *file, int size)
{
    (void)file;
    if (size > 0) progressBytes += (ULONGLONG)size;
    return 1;   /* keep going */
}

static ULONGLONG sizeOf(const wchar_t *path)
{
    WIN32_FILE_ATTRIBUTE_DATA fad;
    if (!GetFileAttributesExW(path, GetFileExInfoStandard, &fad)) return 0;
    return ((ULONGLONG)fad.nFileSizeHigh << 32) | fad.nFileSizeLow;
}

/* Byte-compares two files; used to prove an extracted payload is intact. */
static int sameBytes(const wchar_t *a, const wchar_t *b)
{
    HANDLE ha, hb;
    BYTE bufA[32768], bufB[32768];
    DWORD gotA = 0, gotB = 0;
    int equal = 1;

    ha = CreateFileW(a, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (ha == INVALID_HANDLE_VALUE) return 0;
    hb = CreateFileW(b, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (hb == INVALID_HANDLE_VALUE) { CloseHandle(ha); return 0; }

    for (;;) {
        BOOL ra = ReadFile(ha, bufA, sizeof(bufA), &gotA, NULL);
        BOOL rb = ReadFile(hb, bufB, sizeof(bufB), &gotB, NULL);
        if (!ra || !rb) { equal = 0; break; }
        if (gotA != gotB) { equal = 0; break; }
        if (gotA == 0) break;
        if (memcmp(bufA, bufB, gotA) != 0) { equal = 0; break; }
    }
    CloseHandle(ha);
    CloseHandle(hb);
    return equal;
}

int wmain(int argc, wchar_t **argv)
{
    HMODULE dll;
    fnOpenArchiveW OpenArchiveW_;
    fnReadHeaderExW ReadHeaderExW_;
    fnProcessFileW ProcessFileW_;
    fnCloseArchive CloseArchive_;
    fnGetPackerCaps GetPackerCaps_;
    fnPackFilesW PackFilesW_;
    fnSetProcessDataProcW SetProcessDataProcW_;

    tOpenArchiveDataW oad;
    tHeaderDataExW hdr;
    HANDLE h;
    int rc, entries = 0, caps;
    wchar_t payloadOut[MAX_PATH] = L"", destDir[MAX_PATH], packed[MAX_PATH], addList[MAX_PATH * 2];
    wchar_t srcDir[MAX_PATH], srcName[MAX_PATH];
    const wchar_t *plugin, *archive, *source, *work;   /* source = the slc4-unpack reference */
    wchar_t *slash;
    size_t n;

    if (argc < 5) {
        fwprintf(stderr, L"usage: wcxtest <plugin.wcx64> <archive.slc4z> <reference.json> <workdir>\n");
        return 2;
    }
    plugin = argv[1]; archive = argv[2]; source = argv[3]; work = argv[4];

    printf("Loading the plugin\n");
    dll = LoadLibraryW(plugin);
    ok("plugin loads", dll != NULL, "LoadLibraryW failed");
    if (!dll) return 1;

    OpenArchiveW_        = (fnOpenArchiveW)GetProcAddress(dll, "OpenArchiveW");
    ReadHeaderExW_       = (fnReadHeaderExW)GetProcAddress(dll, "ReadHeaderExW");
    ProcessFileW_        = (fnProcessFileW)GetProcAddress(dll, "ProcessFileW");
    CloseArchive_        = (fnCloseArchive)GetProcAddress(dll, "CloseArchive");
    GetPackerCaps_       = (fnGetPackerCaps)GetProcAddress(dll, "GetPackerCaps");
    PackFilesW_          = (fnPackFilesW)GetProcAddress(dll, "PackFilesW");
    SetProcessDataProcW_ = (fnSetProcessDataProcW)GetProcAddress(dll, "SetProcessDataProcW");
    ok("every entry point resolves",
       OpenArchiveW_ && ReadHeaderExW_ && ProcessFileW_ && CloseArchive_ &&
       GetPackerCaps_ && PackFilesW_ && SetProcessDataProcW_, NULL);
    if (!OpenArchiveW_) return 1;

    caps = GetPackerCaps_();
    ok("declares PK_CAPS_NEW", (caps & PK_CAPS_NEW) != 0, NULL);
    ok("does not claim multi-file archives", (caps & PK_CAPS_MULTIPLE) == 0, NULL);
    ok("does not claim content detection", (caps & PK_CAPS_BY_CONTENT) == 0, NULL);

    /* --- listing, the way Total Commander browses an archive --- */
    printf("\nListing %ls\n", archive);
    ZeroMemory(&oad, sizeof(oad));
    oad.ArcName = (WCHAR *)archive;
    oad.OpenMode = PK_OM_LIST;
    h = OpenArchiveW_(&oad);
    ok("archive opens for listing", h != NULL && oad.OpenResult == E_SUCCESS, NULL);
    if (h) {
        while ((rc = ReadHeaderExW_(h, &hdr)) == E_SUCCESS) {
            ULONGLONG unp = ((ULONGLONG)hdr.UnpSizeHigh << 32) | hdr.UnpSize;
            printf("    %-44ls %10llu bytes\n", hdr.FileName, unp);
            entries++;
            ProcessFileW_(h, PK_SKIP, NULL, NULL);
        }
        ok("listing ends with E_END_ARCHIVE", rc == E_END_ARCHIVE, NULL);
        ok("archive exposes both entries", entries == 2, NULL);
        CloseArchive_(h);
    }

    /* --- extraction --- */
    printf("\nExtracting\n");
    _snwprintf(destDir, MAX_PATH, L"%s\\out", work);
    CreateDirectoryW(destDir, NULL);
    wcscat(destDir, L"\\");

    ZeroMemory(&oad, sizeof(oad));
    oad.ArcName = (WCHAR *)archive;
    oad.OpenMode = PK_OM_EXTRACT;
    h = OpenArchiveW_(&oad);
    ok("archive opens for extraction", h != NULL && oad.OpenResult == E_SUCCESS, NULL);
    if (h) {
        int extracted = 0;
        SetProcessDataProcW_(h, onProgress);
        while (ReadHeaderExW_(h, &hdr) == E_SUCCESS) {
            rc = ProcessFileW_(h, PK_EXTRACT, destDir, hdr.FileName);
            if (rc != E_SUCCESS) { ok("extract entry", 0, "ProcessFileW failed"); break; }
            if (extracted == 0) _snwprintf(payloadOut, MAX_PATH, L"%s%ls", destDir, hdr.FileName);
            extracted++;
        }
        ok("both entries extracted", extracted == 2, NULL);
        ok("progress callback was driven", progressBytes > 0, NULL);
        CloseArchive_(h);
    }
    ok("extracted payload is byte-identical to slc4 unpack", sameBytes(payloadOut, source), NULL);

    /* --- packing, the Alt+F5 path --- */
    printf("\nPacking\n");
    wcsncpy(srcDir, source, MAX_PATH - 1);
    srcDir[MAX_PATH - 1] = L'\0';
    slash = wcsrchr(srcDir, L'\\');
    if (slash) { wcsncpy(srcName, slash + 1, MAX_PATH - 1); *(slash + 1) = L'\0'; }
    else { wcsncpy(srcName, source, MAX_PATH - 1); srcDir[0] = L'\0'; }

    n = wcslen(srcName);
    wcsncpy(addList, srcName, MAX_PATH * 2 - 2);
    addList[n] = L'\0';
    addList[n + 1] = L'\0';          /* double-null terminated, one entry */

    _snwprintf(packed, MAX_PATH, L"%s\\repacked.slc4z", work);
    DeleteFileW(packed);
    rc = PackFilesW_(packed, NULL, srcDir, addList, 0);
    ok("PackFilesW succeeds", rc == E_SUCCESS, NULL);
    ok("archive was created", sizeOf(packed) > 0, NULL);

    /* The freshly packed archive must itself open and list. */
    ZeroMemory(&oad, sizeof(oad));
    oad.ArcName = packed;
    oad.OpenMode = PK_OM_LIST;
    h = OpenArchiveW_(&oad);
    ok("the packed archive opens again", h != NULL && oad.OpenResult == E_SUCCESS, NULL);
    if (h) { ReadHeaderExW_(h, &hdr); CloseArchive_(h); }

    /* --- refusals --- */
    printf("\nRefusals\n");
    {
        wchar_t two[MAX_PATH * 2];
        size_t a = wcslen(srcName);
        wcsncpy(two, srcName, MAX_PATH);
        two[a] = L'\0';
        wcscpy(two + a + 1, srcName);            /* a second entry */
        two[a + 1 + a] = L'\0';
        two[a + 1 + a + 1] = L'\0';
        rc = PackFilesW_(packed, NULL, srcDir, two, 0);
        ok("refuses to pack more than one file", rc == E_TOO_MANY_FILES, NULL);
    }
    {
        wchar_t bogus[MAX_PATH];
        _snwprintf(bogus, MAX_PATH, L"%s\\not-an-archive.slc4z", work);
        HANDLE f = CreateFileW(bogus, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL);
        DWORD put;
        if (f != INVALID_HANDLE_VALUE) { WriteFile(f, "garbage garbage garbage", 23, &put, NULL); CloseHandle(f); }
        ZeroMemory(&oad, sizeof(oad));
        oad.ArcName = bogus;
        oad.OpenMode = PK_OM_LIST;
        h = OpenArchiveW_(&oad);
        ok("rejects a file that is not an archive", h == NULL && oad.OpenResult != E_SUCCESS, NULL);
        if (h) CloseArchive_(h);
        DeleteFileW(bogus);
    }

    FreeLibrary(dll);
    printf("\n%s -- %d failure(s)\n", failures ? "FAILED" : "OK", failures);
    return failures ? 1 : 0;
}

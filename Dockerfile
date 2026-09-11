FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=8080
EXPOSE 8080
# Static only: the codec runs in the browser, there is no server-side API.
CMD ["node", "dev-server.mjs"]

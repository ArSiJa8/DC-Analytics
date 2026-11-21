FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json server.ts ./
COPY public ./public
VOLUME ["/app/data"]
EXPOSE 47391
CMD ["bun", "run", "server.ts"]

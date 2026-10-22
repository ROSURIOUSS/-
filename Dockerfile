FROM node:20-alpine

WORKDIR /app

# Зависимостей нет — копируем только исходники.
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

EXPOSE 3000

# Истории переживают перезапуск контейнера.
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]

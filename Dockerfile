FROM node:24-alpine
LABEL org.opencontainers.image.title="EDITH" org.opencontainers.image.description="Every Device In The House — homelab dashboard"
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production PORT=7575
EXPOSE 7575
VOLUME /app/data
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:7575/api/apps >/dev/null || exit 1
CMD ["node", "server.js"]

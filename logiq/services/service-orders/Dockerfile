FROM node:20-alpine

RUN addgroup -g 10001 -S app \
  && adduser -u 10001 -S -G app -H -s /sbin/nologin app

WORKDIR /app

COPY packages/shared ./packages/shared
COPY services/service-orders/package.json ./services/service-orders/package.json

WORKDIR /app/services/service-orders
RUN npm install --omit=dev

COPY services/service-orders ./

RUN chown -R app:app /app

USER 10001:10001
ENV NODE_ENV=production
ENV PORT=3000
ENV HOME=/tmp
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --retries=8 --start-period=15s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["./node_modules/.bin/tsx", "src/index.ts"]

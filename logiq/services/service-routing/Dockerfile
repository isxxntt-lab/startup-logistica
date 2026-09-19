FROM node:20-alpine

RUN addgroup -g 10001 -S app \
  && adduser -u 10001 -S -G app -H -s /sbin/nologin app

WORKDIR /app

COPY packages/shared ./packages/shared
COPY services/service-routing/package.json ./services/service-routing/package.json

WORKDIR /app/services/service-routing
RUN npm install --omit=dev

COPY services/service-routing ./

RUN chown -R app:app /app

USER 10001:10001
ENV NODE_ENV=production
ENV PORT=3002
ENV HOME=/tmp
EXPOSE 3002

HEALTHCHECK --interval=10s --timeout=5s --retries=8 --start-period=15s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["./node_modules/.bin/tsx", "src/index.ts"]

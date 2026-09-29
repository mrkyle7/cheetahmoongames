FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public

# Cloud Run sets PORT (8080); the server reads it.
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "server.js"]

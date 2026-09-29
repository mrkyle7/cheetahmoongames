FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# No npm dependencies to install.
COPY package.json server.js account.js ./
COPY public ./public

# Cloud Run sets PORT (8080); the server reads it.
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "server.js"]

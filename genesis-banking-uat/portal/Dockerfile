FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY index.html server.mjs ./
COPY public ./public
COPY src ./src
COPY migrations ./migrations
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]

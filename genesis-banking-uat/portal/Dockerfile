FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 libatomic1 && rm -rf /var/lib/apt/lists/*
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY trading/requirements.txt /app/trading/requirements.txt
RUN pip install --no-cache-dir -r trading/requirements.txt
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json index.html server.mjs ./
COPY public ./public
COPY src ./src
COPY migrations ./migrations
COPY schemas ./schemas
COPY contracts ./contracts
COPY trading ./trading
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]

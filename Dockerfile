FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
COPY sql ./sql
COPY public ./public

# The official image ships an unprivileged "node" user.
USER node

EXPOSE 3000
# Configuration comes from the container environment (DATABASE_URL, ACCESS_CODE, SESSION_SECRET, PORT).
CMD ["node", "src/server.js"]

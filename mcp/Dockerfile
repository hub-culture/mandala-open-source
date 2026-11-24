FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production PORT=8795
EXPOSE 8795
USER node
CMD ["npx", "tsx", "src/main.ts"]

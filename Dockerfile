# Baton as an always-on server. Put baton.yaml in the folder mounted at /data;
# Baton keeps its logins, counts and log in /data/.baton, so that folder must
# survive restarts.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY schema ./schema
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir /data && chown node:node /data
COPY --from=build /app/dist ./dist
COPY schema ./schema
COPY apps-script ./apps-script
COPY snippet ./snippet
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/src/cli/main.js", "serve", "--config", "/data/baton.yaml"]

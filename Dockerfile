# Castvoo runs on plain Node.js 22 with no npm packages, so the image is tiny.
FROM node:22-slim
ENV NODE_ENV=production
# Uploaded photos/videos live on the Railway volume mounted at /data.
ENV UPLOAD_DIR=/data/uploads
WORKDIR /app
COPY package.json ./
COPY server ./server
# The Voo Connect kit (VooSquare login, affiliate hand-off, events), copied unchanged from VooSquare's sdk/voo-connect.
COPY voo-connect ./voo-connect
COPY public ./public
COPY scripts/check.js ./scripts/check.js
COPY docs/PRODUCT-FACTS.md ./docs/PRODUCT-FACTS.md
COPY .env.example ./.env.example
# Runs as root on purpose: Railway mounts volumes owned by root, so a non-root user
# could not save uploads there. The app never runs shell commands from user input.
RUN mkdir -p /data/uploads
EXPOSE 3000
CMD ["node", "server/index.js"]

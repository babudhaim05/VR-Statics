FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs issue-session.mjs ./
USER node
ENV AUTH_MODE=session HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "server.mjs"]

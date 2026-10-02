FROM node:20-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY bootstrap.js ./
COPY server.js ./
COPY index.html ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm","start"]

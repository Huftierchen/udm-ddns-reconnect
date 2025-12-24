FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

# Persistenter State
RUN mkdir -p /data

ENV NODE_ENV=production
ENV TZ=Europe/Berlin
ENV DATA_DIR=/data

CMD ["node", "index.js"]

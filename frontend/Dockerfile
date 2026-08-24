FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Now using production start which uses the build artifacts we generated
CMD ["npm", "start"]

FROM apify/actor-node-puppeteer-chrome:20

COPY package*.json ./

RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional \
 && echo "Installed NPM packages:" && npm list --omit=dev || true \
 && echo "Node.js version:" && node --version

COPY . ./

CMD ./start_xvfb_and_run_cmd.sh && npm start --silent

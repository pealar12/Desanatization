# ============================================================================
# Desanatization — production image
#
# Dependencies are installed separately so the runtime layer carries only
# production modules. Configuration arrives as environment variables.
# ============================================================================

FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY index.js app.js config.js x402.js logger.js sanitize.js growth.js agent.js cdp-auth.js notifications.js supervisor.js discoveries.js a2a-commerce.js net-safety.js ./

COPY middleware ./middleware

# Create data directory before dropping privileges
RUN mkdir -p data && chown node:node data

# Drop privileges; the node image ships an unprivileged `node` user.
USER node

EXPOSE 3000

# Liveness only — never block startup on a downstream facilitator.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
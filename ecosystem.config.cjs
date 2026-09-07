/**
 * PM2 configuration for the Kitab Shop API.
 *
 * Committed so it arrives with `git pull` — the process definition lives with
 * the code rather than in whatever flags someone typed on the box last.
 *
 *   pm2 start ecosystem.config.cjs        start (or reload) from this file
 *   pm2 reload rivermossbooks-api         zero-downtime restart
 *   pm2 logs rivermossbooks-api           follow output
 *   pm2 monit                             live CPU/memory dashboard
 *   pm2 save                              persist the list across reboot
 *
 * .cjs, not .js: package.json sets "type": "module", and PM2 reads its config
 * with require().
 */
module.exports = {
  apps: [
    {
      name: "rivermossbooks-api",
      script: "src/index.js",
      // __dirname, not a hardcoded path: the checkout has already moved once
      // and a stale absolute path here means PM2 fails with "Script not found"
      // — which is exactly what happened. This config is always beside the code
      // it describes, so it can just point at itself.
      cwd: __dirname,

      // ONE process in fork mode, deliberately — NOT cluster.
      // RATE_LIMIT_STORE=memory counts per process, so every worker gets its own
      // allowance and a cluster of 4 silently quadruples every rate limit,
      // including the ones protecting login and payment. Redis is a prerequisite
      // for scaling this out; see src/utils/redis-rate-limit.service.js.
      instances: 1,
      exec_mode: "fork",

      // A ceiling, not a target. Steady state is ~300 MB (Node plus a warm
      // geoip-lite); sharp pushes it higher during an image upload. On a 4 GB
      // box shared with mongod, a leak here would otherwise get mongod
      // OOM-killed — restarting the API is much the lesser problem.
      max_memory_restart: "1G",

      autorestart: true,
      // Stops a crash-loop from burning the vCPU: after 10 restarts inside
      // min_uptime, PM2 gives up and leaves it errored for a human to look at.
      min_uptime: "20s",
      max_restarts: 10,
      restart_delay: 5000,

      // The app calls dotenv.config() itself, so .env is the real source of
      // truth. These are only for the couple of values worth guaranteeing even
      // if .env is missing a line.
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },

      error_file: "/var/log/kitab/api-error.log",
      out_file: "/var/log/kitab/api-out.log",
      merge_logs: true,
      time: true,          // timestamp every line; without it logs are unreadable
    },
  ],
};

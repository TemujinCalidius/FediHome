module.exports = {
  apps: [
    {
      name: 'fedihome',
      script: 'npm',
      args: 'start',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        // Forward PORT so pm2 deploys can bind a non-3000 port (defaults to 3000).
        PORT: process.env.PORT || 3000,
      },
      // Auto-restart on crash
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
    },
    {
      // Background scheduler — publishes due scheduled posts (#183) and runs the
      // Bluesky sync. Starts automatically with the app (pm2 start ecosystem.config.cjs),
      // so no hand-rolled cron is needed. Cadences: src/lib/scheduler-config.ts
      // (SCHEDULER_* env vars); admin-editable once the admin backend lands.
      name: 'fedihome-scheduler',
      script: 'npx',
      args: 'tsx --env-file=.env.local scripts/scheduler.ts',
      cwd: __dirname,
      env: { NODE_ENV: 'production' },
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
    },
  ],
};

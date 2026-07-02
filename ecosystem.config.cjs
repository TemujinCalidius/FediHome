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
    // NOTE: there is deliberately no separate scheduler process. FediHome's
    // periodic jobs (scheduled-post publishing #183, Bluesky sync) run inside
    // the app itself (src/instrumentation.ts → src/lib/scheduler.ts), so they
    // start with `npm start` on any deployment. If you previously registered a
    // `fedihome-scheduler` pm2 app (short-lived dev-branch state), remove it
    // BEFORE updating, and persist the removal so a reboot can't resurrect it:
    //   pm2 delete fedihome-scheduler && pm2 save
  ],
};

// PM2 config for traditional VPS deployment.
// For Digital Ocean App Platform, DO manages the process — use app.yaml instead.
// Usage: pm2 start ecosystem.config.cjs
//        pm2 save && pm2 startup   (to survive reboots)

module.exports = {
  apps: [
    {
      name:               'scalper-worker',
      script:             './workers/scalper.mjs',
      instances:          1,
      autorestart:        true,
      watch:              false,
      max_memory_restart: '512M',
      // Restart at midnight UTC to clear memory (matches worker's internal scheduler)
      cron_restart:       '0 0 * * *',
      error_file:         './logs/worker-error.log',
      out_file:           './logs/worker-out.log',
      merge_logs:         true,
      log_date_format:    'YYYY-MM-DD HH:mm:ss UTC',
      env: {
        NODE_ENV:    'production',
        WORKER_MODE: 'paper',
        // APP_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SUPABASE_URL,
        // SUPABASE_SERVICE_ROLE_KEY, WORKER_USER_ID should be set in .env or
        // exported in the shell before running PM2.
      },
    },
  ],
}

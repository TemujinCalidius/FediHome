# Cloudflare Tunnel

Cloudflare Tunnel lets you expose your home-hosted FediHome instance to the internet without opening any ports on your router and without revealing your home IP address. It is the recommended deployment method for home servers.

## Why Cloudflare Tunnel?

- **Your home IP is never exposed.** All traffic routes through Cloudflare's network. Visitors, Fediverse servers, and attackers never see your real IP.
- **No port forwarding.** You don't need to configure your router or deal with NAT. The tunnel client makes an outbound connection to Cloudflare.
- **Free SSL/TLS.** Cloudflare provides HTTPS automatically.
- **Free DDoS protection.** Cloudflare absorbs attack traffic before it reaches your network.
- **Works behind CGNAT.** Even if your ISP doesn't give you a public IP, tunnels still work because the connection is outbound.
- **Free tier.** Cloudflare Tunnels are free for personal use.

## Prerequisites

- A domain name (you can register one through Cloudflare or transfer an existing one)
- A Cloudflare account (free)
- FediHome installed and running locally on `http://localhost:3000`

## Step 1: Add Your Domain to Cloudflare

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) and sign up or log in.
2. Click **Add a site** and enter your domain name.
3. Select the **Free** plan.
4. Cloudflare will scan your existing DNS records. Review them and continue.
5. Cloudflare gives you two nameservers (e.g., `anna.ns.cloudflare.com` and `bob.ns.cloudflare.com`).
6. Go to your domain registrar (Namecheap, Google Domains, etc.) and change the nameservers to the ones Cloudflare provided.
7. Wait for DNS propagation (usually 5-30 minutes, can take up to 24 hours).
8. Once Cloudflare confirms the domain is active, proceed.

## Step 2: Install cloudflared

### macOS

```bash
brew install cloudflared
```

### Linux (Debian/Ubuntu)

```bash
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update
sudo apt install cloudflared
```

### Linux (Other / Manual)

```bash
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared
sudo mv cloudflared /usr/local/bin/
```

For ARM (Raspberry Pi):

```bash
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o cloudflared
chmod +x cloudflared
sudo mv cloudflared /usr/local/bin/
```

### Windows

Download the installer from [Cloudflare's releases page](https://github.com/cloudflare/cloudflared/releases/latest) and run it.

Or use winget:

```powershell
winget install Cloudflare.cloudflared
```

## Step 3: Authenticate cloudflared

```bash
cloudflared tunnel login
```

This opens a browser window. Select the domain you added to Cloudflare. A certificate is saved to `~/.cloudflared/cert.pem`.

## Step 4: Create a Tunnel

```bash
cloudflared tunnel create fedihome
```

This outputs a tunnel ID (a UUID like `a1b2c3d4-e5f6-7890-abcd-ef1234567890`). Note this ID — you'll need it next.

A credentials file is saved to `~/.cloudflared/<TUNNEL_ID>.json`.

## Step 5: Configure the Tunnel

Create the config file at `~/.cloudflared/config.yml`:

```yaml
tunnel: a1b2c3d4-e5f6-7890-abcd-ef1234567890  # your tunnel ID
credentials-file: /path/to/.cloudflared/a1b2c3d4-e5f6-7890-abcd-ef1234567890.json

ingress:
  - hostname: yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

Replace:
- `a1b2c3d4-e5f6-7890-abcd-ef1234567890` with your actual tunnel ID
- `/path/to/.cloudflared/` with the actual path (usually `~/.cloudflared/` on macOS/Linux or `C:\Users\YourName\.cloudflared\` on Windows)
- `yourdomain.com` with your domain

The last `ingress` rule is a catch-all that returns 404 for unmatched hostnames.

## Step 6: Configure DNS

Route your domain through the tunnel:

```bash
cloudflared tunnel route dns fedihome yourdomain.com
```

This creates a CNAME record in Cloudflare DNS pointing `yourdomain.com` to your tunnel.

## Step 7: Test the Tunnel

```bash
cloudflared tunnel run fedihome
```

Now visit `https://yourdomain.com` in your browser. You should see your FediHome instance with a valid HTTPS certificate.

Press `Ctrl+C` to stop the tunnel when you're done testing.

## Step 8: Run as a System Service

You want the tunnel to start automatically on boot and restart if it crashes.

### macOS (launchd)

```bash
sudo cloudflared service install
```

This installs a launchd service that starts on boot. You can manage it with:

```bash
sudo launchctl list | grep cloudflared     # check status
sudo launchctl stop com.cloudflare.cloudflared   # stop
sudo launchctl start com.cloudflare.cloudflared  # start
```

### Linux (systemd)

```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

Manage with:

```bash
sudo systemctl status cloudflared    # check status
sudo journalctl -u cloudflared -f    # view logs
sudo systemctl restart cloudflared   # restart
```

### Windows

```powershell
cloudflared service install
```

This creates a Windows service. Manage it from Services (`services.msc`) or with:

```powershell
sc query cloudflared          # check status
sc stop cloudflared           # stop
sc start cloudflared          # start
```

## Update Your .env.local

Make sure your FediHome environment matches your public domain:

```
SITE_URL=https://yourdomain.com
FEDI_DOMAIN=yourdomain.com
FEDI_HANDLE=yourhandle
```

Restart FediHome after changing these.

## Troubleshooting

### "Bad gateway" or 502 error

FediHome is not running on the expected port. Verify:

```bash
curl http://localhost:3000
```

If this fails, start FediHome:

```bash
cd /path/to/fedihome
npm start       # or: pm2 start ecosystem.config.cjs
```

### Tunnel is running but site won't load

Check the tunnel status:

```bash
cloudflared tunnel info fedihome
```

Verify the DNS record exists in Cloudflare dashboard. The CNAME for `yourdomain.com` should point to `<tunnel-id>.cfargotunnel.com`.

### "DNS resolution error" in browser

DNS propagation may not be complete. Wait a few minutes and try again. You can check propagation at [dnschecker.org](https://dnschecker.org).

### WebFinger not working

Mastodon and other Fediverse servers need to reach `https://yourdomain.com/.well-known/webfinger`. Test it:

```bash
curl "https://yourdomain.com/.well-known/webfinger?resource=acct:yourhandle@yourdomain.com"
```

If this returns a JSON response with your actor URL, federation is working. If it fails, check that:
1. `FEDI_HANDLE` and `FEDI_DOMAIN` in `.env.local` match what you're querying
2. `SITE_URL` starts with `https://`
3. The tunnel is running and DNS is configured

### "Connection refused" in cloudflared logs

The tunnel cannot reach `localhost:3000`. Either FediHome is not running or it's on a different port. Check your `package.json` — the default dev port is 3001, the production port is 3000.

### SSL certificate errors between cloudflared and your app

By default, cloudflared connects to your local app over plain HTTP (`http://localhost:3000`), which is fine — the Cloudflare-to-visitor connection is encrypted. You do NOT need to set up a local SSL certificate.

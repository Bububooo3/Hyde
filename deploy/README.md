# Illinois cPanel deploy for Hyde

## Architecture

GitHub Actions builds Hyde on pushes to `main` and publishes only the compiled `dist/` files to a private `hyde-site` branch. cPanel uses an **outbound**, read-only SSH deploy key to clone/pull that branch. A cPanel cron job (every 15 minutes) synchronizes files into a **dedicated** `public_html/hyde/` directory.

This avoids relying on inbound SSH from a GitHub-hosted runner, which may not be reachable under Illinois campus SSH/VPN restrictions. Node.js is **not required on cPanel**.

## Initial GitHub setup

1. Merge this PR into `main`. Open **Actions → Build Hyde for Illinois cPanel**.
2. Run manually or push to `main`; wait for a successful action and the generated `hyde-site` branch.
3. If publishing fails with HTTP 403, review **Settings → Actions → General → Workflow permissions** for `GITHUB_TOKEN` write access, subject to repository policy.

## SSH setup, in the cPanel account

Open **cPanel → Advanced → Terminal** (or connect to cPanel using campus VPN/SSH according to Illinois policy).

```bash
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
ssh-keygen -t ed25519 -f "$HOME/.ssh/hyde_github_readonly" -C hyde-cpanel-deploy
cat "$HOME/.ssh/hyde_github_readonly.pub"
```

Use an empty key passphrase **only for this dedicated unattended deploy key**, because cron cannot type one. Keep the private key inside the cPanel account.

On GitHub, open **Bububooo3/Hyde → Settings → Deploy keys → Add deploy key**, paste the public key, and leave **Allow write access** unchecked.

Add the following to `~/.ssh/config` in cPanel, preserving any existing entries:

```sshconfig
Host github-hyde
  HostName github.com
  User git
  IdentityFile ~/.ssh/hyde_github_readonly
  IdentitiesOnly yes
```

Run `chmod 600 ~/.ssh/config ~/.ssh/hyde_github_readonly`, then `ssh -T git@github-hyde`. On first contact, **verify the ED25519 host fingerprint** against [GitHub's published fingerprints](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints) before accepting it. A successful authentication message will say that GitHub does not provide shell access; SSH can exit with code 1 in that case.

If outbound SSH on port 22 fails, GitHub also supports `ssh.github.com` on port 443: change the `HostName` to `ssh.github.com` and add `Port 443`. Reverify the host key before accepting.

Confirm repository access:

```bash
git ls-remote git@github-hyde:Bububooo3/Hyde.git refs/heads/hyde-site
```

## Prepare the website directory

The script assumes `$HOME/public_html/hyde` is the desired document root for `https://YOUR-WEBSITE/hyde/`. Check cPanel **Domains → Document Root**: some UIUC accounts use a different root. Edit `WEBROOT` in the script as needed; **never** point it at a shared `public_html` directory containing other websites.

```bash
mkdir -p "$HOME/public_html/hyde"
touch "$HOME/public_html/hyde/.hyde-deploy-managed"
```

Upload the repo's `deploy/cpanel-sync.sh` to `$HOME/hyde-sync.sh` using cPanel File Manager. **Keep it outside public_html**.

```bash
chmod 700 "$HOME/hyde-sync.sh"
command -v git
command -v rsync
bash "$HOME/hyde-sync.sh"
```

The deployment deletes obsolete files from the dedicated Hyde directory, while preserving `.htaccess` and `.hyde-deploy-managed`. Never place unrelated site content in that directory.

## Automation

In **cPanel → Advanced → Cron Jobs**, create a job that runs every 15 minutes:

```cron
*/15 * * * * /bin/bash /home/YOUR_CPANEL_USERNAME/hyde-sync.sh >> /home/YOUR_CPANEL_USERNAME/hyde-deploy.log 2>&1
```

For the cPanel Cron Jobs UI, enter the minute/hour/day fields separately and only put the `/bin/bash ...` command in **Command**. Replace `YOUR_CPANEL_USERNAME` with the actual cPanel home-directory account name.

After any successful push to `main`, GitHub Actions creates the static build; the cron job makes it live on the next scheduled run (usually within 15 minutes). Inspect the GitHub Actions log and `~/hyde-deploy.log` if deployment fails.

## Important limits

- **Do not store the SSH private key in the repo or web directory.** The read-only deploy key can read the entire private Hyde source repository, even though the sync script only downloads the build branch.
- This approach builds **on GitHub**, not cPanel. The static server only deploys compiled files.
- UIUC may restrict shell access or outbound GitHub connectivity on your particular hosting account. If so, request an allowed deployment mechanism from hosting support.

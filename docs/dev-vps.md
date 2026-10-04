# Dev deployment on the VPS

The dev branch deploys Hararest to Docker on the self-hosted GitHub Actions VPS.
The main branch keeps its existing Heroku deployment.

The runner reads runtime settings from /opt/oohara/hararest-dev.env; this file
stays on the VPS and is not checked into Git. Replace `github-runner` with the
Linux account that runs the self-hosted runner, then create the file as that
account so the workflow can read it:

    RUNNER_USER=github-runner
    sudo install -d -m 700 -o "$RUNNER_USER" -g "$RUNNER_USER" /opt/oohara
    sudo -u "$RUNNER_USER" touch /opt/oohara/hararest-dev.env
    sudo chmod 600 /opt/oohara/hararest-dev.env
    sudo -u "$RUNNER_USER" nano /opt/oohara/hararest-dev.env

Copy the required settings from .env.example into that file and fill in the
real values. PORT should be 1337. Put optional YouTube and Instagram cookie
files in /opt/oohara/hararest-cookies/.

The deployment creates or reuses the Docker network oohara-dev, builds
compose.dev.yml, and checks Hararest from inside the container. The host port
1338 binds to the `TAILSCALE_IP` from the env file (and defaults to
127.0.0.1 if that variable is unset). Kotonehara dev containers on the same
network can reach the API at http://hararest-dev:1337/.

The runner account needs Docker access and permission to read the environment
file and cookie directory. Get the VPS address with `tailscale ip -4` and set
`TAILSCALE_IP` to that value to expose this dev API over the tailnet.

## Separate branch workflows

Both branches contain `.github/workflows/dev.yml` and `main.yml`:

- `dev.yml`: pushes to `dev` run checks on `self-hosted`, then deploy Docker on the VPS.
- `main.yml`: pushes to `main` run checks on `ubuntu-latest`, then deploy to Heroku.
- Neither workflow has a `pull_request` or `pull_request_target` trigger.
- Manual runs only run checks on the matching branch; deployments require a push.
- Branch guards skip jobs if the wrong branch is selected for a manual run.

Merging `dev` into `main` keeps both files. The resulting push runs only the
main workflow and can deploy production after checks pass. Workflow files still
participate in merges, so review changes to `main.yml` in the PR.

Dev runtime env files and database volumes remain on the VPS. Heroku deployment
uses GitHub secrets `HEROKU_API_KEY` / `HEROKU_APP_NAME`; production application
env remains in Heroku Config Vars.

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

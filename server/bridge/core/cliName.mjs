/**
 * How to run a Bridge command in the user's setup, for hints: MCB_CLI_NAME (set by the installers' `mc-bridge`
 * command and launchers), else the Docker form, else the repository form.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function cliCommand(env = process.env) {
  if (env.MCB_CLI_NAME) return env.MCB_CLI_NAME;
  return env.MCB_DOCKER === "1" ? "docker compose exec bridge mc-bridge" : "npm run bridge --";
}

/**
 * What a person grants when they grant a plugin. Shown by `plugins pin`, in the log when a plugin loads and when one is
 * refused for not being granted. Plain on purpose: the Node permission flags are a seat belt, not a boundary.
 */
export const PLUGIN_TRUST_NOTICE =
  "A plugin runs as your user on this computer. The sandbox limits files, programs and the brokered network, but it cannot stop a plugin from signalling the Bridge process (for example killing it) or from opening its own network connections. Grant only code you have read. To remove the signal risk, run plugins as a different user (sources.pluginUser, needs root); see docs/source-contract.md.";

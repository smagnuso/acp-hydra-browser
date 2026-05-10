import { homedir } from "node:os";
import { resolve } from "node:path";

const HOME_DIR = `${homedir()}/.acp-hydra-browser`;

export function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

export const paths = {
  home(): string {
    return HOME_DIR;
  },
  authkeyFile(): string {
    return `${HOME_DIR}/authkey`;
  },
  linkFile(): string {
    return `${HOME_DIR}/link`;
  },
  configFile(): string {
    return `${homedir()}/.acp-hydra-browser.conf`;
  },
};

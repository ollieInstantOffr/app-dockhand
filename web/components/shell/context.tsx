"use client";

import type { CustomSshConn } from "@/lib/customSsh";
import { createContext, useContext, type ReactNode } from "react";
import type { IconName } from "../icons";
import type { HostInput, User } from "@/lib/types";

export type ToastKind = "ok" | "error" | "info" | "warn";

export interface ToastInput {
  title: string;
  text?: string;
  kind?: ToastKind;
  action?: string;
  onAction?: () => void;
  timeout?: number; // ms, default 4500; 0 = sticky
}

export interface ConfirmInput {
  title: string;
  text: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  icon?: IconName;
  details?: { k: string; v: string }[];
  typeToConfirm?: string; // user must type this exact string
}

/** Dialogs rendered by components/dialogs (the wizards). */
export type DialogState =
  | { type: "host"; hostId?: string; prefill?: HostInput } // add (or edit when hostId given); prefill = start at the connection test
  | { type: "apiKey" }
  | { type: "pull"; hostId?: string; image?: string }
  | { type: "compose"; hostId: string; stack?: string } // stack given = edit, else new stack wizard
  | { type: "github" }
  | { type: "monitor"; hostId?: string }
  | { type: "network"; hostId: string }
  | { type: "attachNetwork"; hostId: string; networkId: string; networkName: string }
  | { type: "channel"; channelType?: string }
  | { type: "customSsh" };

/** A session in the floating terminal window. */
export type TerminalTarget =
  | { kind: "shell"; hostId: string } // SSH login shell on the host
  | { kind: "exec"; hostId: string; containerId: string; name?: string } // shell inside a container
  | { kind: "logs"; hostId: string; containerId: string; name?: string } // live container logs
  | { kind: "ssh"; id: string; conn: CustomSshConn }; // SSH to an address the user typed in (credentials stay in memory)

export interface Shell {
  user: User;
  setUser: (u: User) => void;
  toast: (t: ToastInput) => void;
  confirm: (c: ConfirmInput) => Promise<boolean>;
  openDialog: (d: DialogState) => void;
  closeDialog: () => void;
  openContainer: (hostId: string, containerId: string, tab?: "overview" | "env" | "mounts" | "logs" | "events") => void;
  closeContainer: () => void;
  /** Open (or focus) a tab in the floating terminal window. */
  openTerminal: (t: TerminalTarget) => void;
  openPalette: () => void;
  openShortcuts: () => void;
  openNotifications: () => void;
  theme: "light" | "dark" | "system";
  setTheme: (t: "light" | "dark" | "system") => void;
  toggleTheme: () => void;
}

export const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const s = useContext(ShellContext);
  if (!s) throw new Error("useShell must be used inside <AppShell>");
  return s;
}

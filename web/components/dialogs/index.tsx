"use client";

import type { DialogState } from "../shell/context";
import { HostDialog } from "./HostDialog";
import { ApiKeyDialog } from "./ApiKeyDialog";
import { PullDialog } from "./PullDialog";
import { ComposeDialog } from "./ComposeDialog";
import { GithubDialog } from "./GithubDialog";
import { MonitorDialog } from "./MonitorDialog";
import { AttachNetworkDialog, NetworkDialog } from "./NetworkDialogs";
import { ChannelDialog } from "./ChannelDialog";

/** Renders the wizard dialog for the current shell dialog state. */
export function Dialogs({ state, onClose }: { state: DialogState; onClose: () => void }) {
  switch (state.type) {
    case "host":
      return <HostDialog key={state.hostId ?? "new"} hostId={state.hostId} prefill={state.prefill} onClose={onClose} />;
    case "apiKey":
      return <ApiKeyDialog onClose={onClose} />;
    case "pull":
      return <PullDialog hostId={state.hostId} image={state.image} onClose={onClose} />;
    case "compose":
      return <ComposeDialog key={`${state.hostId}/${state.stack ?? ""}`} hostId={state.hostId} stack={state.stack} onClose={onClose} />;
    case "github":
      return <GithubDialog onClose={onClose} />;
    case "monitor":
      return <MonitorDialog hostId={state.hostId} onClose={onClose} />;
    case "network":
      return <NetworkDialog hostId={state.hostId} onClose={onClose} />;
    case "attachNetwork":
      return <AttachNetworkDialog hostId={state.hostId} networkId={state.networkId} networkName={state.networkName} onClose={onClose} />;
    case "channel":
      return <ChannelDialog channelType={state.channelType} onClose={onClose} />;
    default:
      return null;
  }
}

import {
  createManagedAcpV1ClientWithPrivateIdentityVault,
} from "./managed-client.js";
import {
  createHostPrivateBindingIdentityVault,
  type HostPrivateBindingIdentityVault,
} from "./private-binding-identity-vault.js";
import type {
  CreateManagedAcpV1ClientOptions,
  ManagedAcpV1Client,
} from "./types.js";

export { createHostPrivateBindingIdentityVault };
export type { HostPrivateBindingIdentityVault };

export interface HostPrivateManagedAcpV1ClientOptions
extends CreateManagedAcpV1ClientOptions {
  readonly identityVault: HostPrivateBindingIdentityVault;
}

/** Host composition only; deliberately absent from the package main export. */
export function createManagedAcpV1ClientWithHostPrivateIdentity(
  options: HostPrivateManagedAcpV1ClientOptions,
): ManagedAcpV1Client {
  const { identityVault, ...clientOptions } = options;
  return createManagedAcpV1ClientWithPrivateIdentityVault(
    clientOptions,
    identityVault,
  );
}

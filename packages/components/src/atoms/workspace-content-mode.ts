import { atom } from 'jotai';
import type { WorkspaceAdmissionDescriptor } from '@lody/cloud-api';

/** The runtime's admission verdict for the routed workspace, never a persisted mode hint.
 * `descriptor: null` is a provisional ordinary admission: no local or listed
 * encryption evidence exists, the pre-E2EE offline-first runtime may open, and
 * the authoritative mode is verified in the background. An encrypted answer
 * retires that runtime before the verdict changes.
 */
export type WorkspaceContentMode =
  | {
      accountId: string | null;
      workspaceSlug: string;
      workspaceId: string;
      descriptor: WorkspaceAdmissionDescriptor;
    }
  | {
      accountId: string | null;
      workspaceSlug: string;
      workspaceId: string | null;
      descriptor: null;
    };

export const workspaceContentModeAtom = atom<WorkspaceContentMode | null>(null);

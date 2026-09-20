export const INVITATION_REF_SESSION_KEY = "infinite-canvas-invitation-ref-v1";

type InvitationRefStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function invitationRefFromSearch(search: string) {
    return new URLSearchParams(search).get("ref")?.trim() || "";
}

export function rememberInvitationRef(search: string, storage: InvitationRefStorage) {
    const ref = invitationRefFromSearch(search);
    if (!ref) return "";
    try {
        storage.setItem(INVITATION_REF_SESSION_KEY, ref);
    } catch {
        // The current URL remains usable when session storage is unavailable.
    }
    return ref;
}

export function resolveInvitationRef(search: string, storage: InvitationRefStorage) {
    const ref = rememberInvitationRef(search, storage);
    if (ref) return ref;
    try {
        return storage.getItem(INVITATION_REF_SESSION_KEY)?.trim() || "";
    } catch {
        return "";
    }
}

export function clearInvitationRef(storage: InvitationRefStorage) {
    try {
        storage.removeItem(INVITATION_REF_SESSION_KEY);
    } catch {
        // Registration already succeeded, so storage cleanup is best effort.
    }
}

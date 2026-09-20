import { expect, test } from "bun:test";

import { clearInvitationRef, INVITATION_REF_SESSION_KEY, rememberInvitationRef, resolveInvitationRef } from "../src/lib/invitation-ref";

function memoryStorage() {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    };
}

test("remembers the invitation ref when the registration page opens", () => {
    const storage = memoryStorage();

    expect(rememberInvitationRef("?ref=ic_example", storage)).toBe("ic_example");
    expect(storage.getItem(INVITATION_REF_SESSION_KEY)).toBe("ic_example");
});

test("restores the invitation ref after client-side navigation removes the query", () => {
    const storage = memoryStorage();
    rememberInvitationRef("?ref=ic_example", storage);

    expect(resolveInvitationRef("", storage)).toBe("ic_example");
});

test("prefers a new URL ref and clears it after registration", () => {
    const storage = memoryStorage();
    rememberInvitationRef("?ref=ic_old", storage);

    expect(resolveInvitationRef("?ref=%20ic_new%20", storage)).toBe("ic_new");
    expect(storage.getItem(INVITATION_REF_SESSION_KEY)).toBe("ic_new");

    clearInvitationRef(storage);
    expect(resolveInvitationRef("", storage)).toBe("");
});



Let me read the relevant sections of the worker file.
Now I'll make both fixes.
Verify and commit.
Both changes verified. Now committing.
Done. Both fixes applied and committed:

1. **`deleteUser`** (line 434): `kvPut` now passes `{ allowShrink: true }` so the shrink guard won't re-merge a deleted user.
2. **`addUser`** (line 392-394): Case-insensitive duplicate name check returns 409 before creating a new user.

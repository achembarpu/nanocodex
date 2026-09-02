# nanocodex-connect-protocol

Low-level, runtime-independent framing for Connect connector callback state.

```js
import {
  isScopedConnectConnectorState,
  scopedConnectConnectorState,
  unscopedConnectConnectorState,
} from "nanocodex-connect-protocol";

const callbackState = scopedConnectConnectorState("0123456789abcdef");
isScopedConnectConnectorState(callbackState); // true
unscopedConnectConnectorState(callbackState); // "0123456789abcdef"
```

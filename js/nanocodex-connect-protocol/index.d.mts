/** Frames a valid broker authorization state for a Connect callback. */
export declare function scopedConnectConnectorState(value: unknown): string;

/** Reports whether a value is a framed Connect connector callback state. */
export declare function isScopedConnectConnectorState(value: unknown): value is string;

/** Returns the broker state from a valid framed callback state. */
export declare function unscopedConnectConnectorState(value: unknown): string | undefined;

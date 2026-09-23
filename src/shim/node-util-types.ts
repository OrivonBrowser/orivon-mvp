// `util/types` module target (module-map.ts): the `util` package's types
// object, as default export and as named members.

import { types } from './node-util.js'

export const {
  isAnyArrayBuffer, isArgumentsObject, isArrayBuffer, isArrayBufferView, isAsyncFunction, isBigInt64Array,
  isBigUint64Array, isBooleanObject, isBoxedPrimitive, isDataView, isDate, isFloat32Array, isFloat64Array,
  isGeneratorFunction, isGeneratorObject, isInt8Array, isInt16Array, isInt32Array, isMap, isMapIterator,
  isNativeError, isNumberObject, isPromise, isRegExp, isSet, isSetIterator, isSharedArrayBuffer, isStringObject,
  isSymbolObject, isTypedArray, isUint8Array, isUint8ClampedArray, isUint16Array, isUint32Array, isWeakMap, isWeakSet
} = types

export default types

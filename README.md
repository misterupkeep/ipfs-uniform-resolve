# ipfs-uniform-resolve

Resolve CIDs into data using a well-defined method, that works across both
UnixFS and "regular" node types.

```ts
import Resolve from "ipfs-uniform-resolve";

const resolver = Resolve(blockApi, nameApi);
const cid = await resolver.resolveIpns(ipnsCid);
const { value, block, cid: finalCid } = await resolver.resolve(cid, "/dir/file.json/key/0");

console.log(value);
```

## Resolution Algorithm

Starting from a CID pointing at a block, and given a path, `resolve(cid, path)`
will dereference the CID to the block, and then follow each path segment in the
path, dereferencing CIDs along the way if necessary.

If `resolve()` hits a [DAG-PB]() (UnixFS) node, path segments will be treated as
UnixFS path segments, i.e. `/foo` will actually be `node.Links[foo]`.

If `resolve()` hits a regular (non DAG-PB) block, path segments will correspond
directly to object entries, i.e. `/a/b/0` will be `node.a.b[0]`.

CIDs in regular (non DAG-PB) block are detected if:
- The node is a string, and `CID.parse()` succeeds
- The node is an object, and `CID.asCID()` succeeds

`CID` in this case being the definition in the `multiformats` package.

CIDs will be automatically dereferenced, if needed.

## API

The library default exports a factory function that returns the library instance:
```ts
Resolver(block, name, multidecoder)
```
- `block` and `name` are object that implement the Block and Name API of the [IPFS Core interface](https://github.com/ipfs/js-ipfs/tree/master/packages/interface-ipfs-core), respectively
- `multidecoder` is an optional parameter to which you can either pass `{ decoders, hashers }`, or a [Multidecoder](https://github.com/misterupkeep/multiformat-multicodec) implementation.

The resulting object contains two functions:

### `async resolveIpns(cid: CID | string, timeout?: number): Promise<CID>`

Resolves a CID as if it were an IPNS link until it resolves into a regular block
CID. The function _will_ throw if given an invalid CID, or if resolution
otherwise fails.

```ts
const cid = await resolver.resolveIpns("ipfs.io");
```

### `async resolve(cid: CID, path: string = "/", options?)`

Resolve an IPLD value starting from a CID, following a path. The algorithm with
which it does this is defined [here](#resolution-algorithm).

`options` is an object which affects the particular behaviour of the resolution:
- `options.followPb` - Whether or not to follow path across DAG-PB nodes. Defaults to `true`
- `options.followIpld` - Whether or not to follow path across non-DAG-PB (regular) nodes. Defaults to `true`

Will throw `TypeError` if the passed CID has a codec of `libp2p-key` (`0x72`).
Currently, this is treated as only being used for IPNS. Please submit a bug
report if you have a different use case.

Will throw `DeadEndError` if resolution can't move forward because of a missing
object entry. The error contains `cid`, `at`, and `remaining` properties which
point to which block/path the error happened.

```ts
const { value, cid, block } =  await resolver.resolve(cid, path, { followIpld: false });
```

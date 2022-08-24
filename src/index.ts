import { CID } from "multiformats";
import { Block } from "multiformats/block";

import type { API as BlockAPI } from "ipfs-core-types/block";
import type { API as NameAPI } from "ipfs-core-types/name";
import { BlockMulticodec, Multidecoder } from "multiformat-multicodec";

import * as json from "@ipld/dag-json";
import * as cbor from "@ipld/dag-cbor";
import * as pb from "@ipld/dag-pb";
import { BlockDecoder } from "multiformats/codecs/interface";
import { Hasher } from "multiformats/hashes/hasher";

import { DeadEndError } from "./error";

// The code for `libp2p-key-codec'.
const kLibp2pKeyCodec = 0x72;

/**
 * Factory function that takes in its dynamic dependencies and returns a library
 * object.
 * @param block The `block` API of an IPFS Core impl. Only needs to exist `block::get()`
 * @param name The `name` API of an IPFS Core impl. Only needs to exist `name::resolve()`
 * @param [multidecoder] Either an impl of the [Multidecoder]{@link Multidecoder} interface, or an object containing an array of `decoders` and `hashers` that will be added to the default Multidecoder.
 * @returns Library object
 */
export default function (
  block: Pick<BlockAPI, "get">,
  name: Pick<NameAPI, "resolve">,
  multidecoder: Multidecoder<any> & {
    decoders: BlockDecoder<any, any>[];
    hashers: Hasher<any, any>[];
  } = undefined as any
) {
  const defaultMultidecoder = new BlockMulticodec<any>({
    codecs: [json, cbor, pb],
  });

  // Use the user-given multidecoder, or add the user's decoders/hashers
  let decoder: Multidecoder<any> = defaultMultidecoder;
  if (
    typeof multidecoder === "object" &&
    !("decoders" in multidecoder) &&
    !("hashers" in multidecoder)
  ) {
    decoder = multidecoder;
  } else {
    if (multidecoder?.decoders)
      multidecoder.decoders.forEach((d) => decoder.addDecoder(d));
    if (multidecoder?.hashers)
      multidecoder.hashers.forEach((h) => decoder.addHasher(h));
  }

  return {
    /**
     * Resolves a CID as if it were an IPNS link until it resolves into a regular block CID.
     * @param {CID | string} cid The CID which to resolve
     * @param {number} [timeout] Max timeout on the recursive query
     * @throws Will throw if `cid` is invalid, or resolution otherwise fails.
     */
    async resolveIpns(cid: CID | string, timeout?: number): Promise<CID> {
      let ipnsAddr = "/ipns/";
      if (typeof cid === "string") ipnsAddr += cid;
      else ipnsAddr += cid.toString();

      let r = null;
      for await (const i of name.resolve(ipnsAddr, {
        recursive: true,
        timeout,
      }))
        r = i;

      // Cut out the /ipns/ from the start
      return CID.parse(r.slice(6));
    },

    /**
     * Resolve an IPLD value starting from a CID, following a path.
     * Will traverse DAG-PB (UnixFS) by treating path segments as UnixFS path segments (i.e. it will follow *files*, and not nodes).
     *
     * Will dereference CIDs in non-UnixFS nodes.
     * CIDs are detected if:
     *  - The node is a string, and `CID.parse()` succeeds
     *  - The node is an object, and `CID.asCID()` succeeds
     * @see CID.parse
     * @see CID.asCID
     *
     * @param {CID} cid Starting block CID
     * @param {string} [path] The path which to resolve. Defaults to `/` (doesn't move)
     * @param {Object} [options] Resolution configuration
     * @param {boolean} [options.followPb] Whether or not to follow path across DAG-PB nodes. Defaults to `true`
     * @param {boolean} [options.followIpld] Whether or not to follow path across non-DAG-PB (regular) nodes. Defaults to `true`
     *
     * @throws {TypeError} Passed CID has codec `libp2p-key` (0x72). Currently, this is treated as only being used for IPNS. Please submit a bug report if you have a different use case.
     * @throws {DeadEndError} Resolution can't move forward because of missing object entry
     */
    async resolve<T = any>(
      cid: CID,
      path: string = "/",
      options?: { followPb?: boolean; followIpld?: boolean }
    ): Promise<{ value: T; cid: CID; block: Block<any> }> {
      // TODO: maybe there is a non IPNS use for this
      if (cid.code === kLibp2pKeyCodec) {
        throw TypeError(
          "Received CID with codec for 'libp2p-key'. " +
            "If you need to resolve IPNS into a CID, call resolveIpns() first"
        );
      }

      const bytes = await block.get(cid);
      const decoded = await decoder.decode({
        codec: cid.code,
        hasher: cid.multihash.code,
        bytes,
      });

      // TODO: optimise by wrapping `CID -> [PathSeg] -> Promise`
      const segs = path.split(/\/+/).filter((s) => s.length);
      const [curr, ...rest] = segs;

      // Bail out early
      if (!segs.length)
        return { value: decoded.value, cid: decoded.cid, block: decoded };

      // This is a DAG-PB file node, traverse it differently
      if (cid.code === pb.code) {
        if (options?.followPb === false) {
          throw new DeadEndError(
            `Resolution hit dead end at CID ${cid.toString()}: node is a DAG-PB node, but 'followPb' is set to 'false'`,
            cid,
            curr,
            rest.join("/")
          );
        }

        const node = decoded.value as pb.PBNode;
        const child = node.Links.find((n) => n.Name === curr);

        if (child) {
          // Found a link matching the leftmost path segment
          return await this.resolve(child.Hash, rest.join("/"), options);
        } else {
          // No link: give up
          throw new DeadEndError(
            `Resolution hit dead end at CID ${cid.toString()}: no link to ${curr}`,
            cid,
            curr,
            rest.join("/")
          );
        }
      }

      // This is a "regular" codec block
      else {
        if (options?.followIpld === false) {
          throw new DeadEndError(
            `Resolution hit dead end at CID ${cid.toString()}: node is an IPLD node, but 'followIpld' is set to 'false'`,
            cid,
            curr,
            rest.join("/")
          );
        }

        let node = decoded.value;
        for (const [i, seg] of segs.entries()) {
          if (Array.isArray(node)) {
            // Arrays are indexed by numbers
            node = node[JSON.parse(seg)];
          } else node = node[seg];

          if (node === undefined) {
            throw new DeadEndError(
              `Resolution hit dead end at CID ${cid.toString()}: object has no property at path /${segs
                .slice(0, i)
                .reduce((acc, x) => acc + "/" + x)}`,
              cid,
              curr,
              rest.join("/")
            );
          }

          // TODO: how are CIDs canonically stored in IPLD?
          const asCid = CID.asCID(node);
          if (asCid) {
            return await this.resolve(asCid, segs.slice(i).join("/"), options);
          }

          let cidStr = null;
          try {
            cidStr = CID.parse(node);
          } catch {}
          if (cidStr) {
            return await this.resolve(cidStr, segs.slice(i).join("/"), options);
          }
        }

        return { value: node, cid, block: decoded };
      }
    },
  };
}

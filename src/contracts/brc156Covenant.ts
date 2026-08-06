/** Clean-room BRC-156 BOLT-style alternating proof covenant. */
import {
  assert, ByteString, hash256, int2ByteString, len, method, prop, PubKey,
  pubKey2Addr, Sha256, Sig, slice, SmartContract, toByteString, Utils,
} from 'scrypt-ts'

export class Brc156Covenant extends SmartContract {
  static readonly ROLE_TIP = 0n
  static readonly ROLE_PROOF = 1n
  static readonly TIP_SATS = 1n
  static readonly BEACON_SATS = 2n
  static readonly PROOF_SATS = 3n

  @prop() role: bigint
  @prop() origin: ByteString
  @prop() originScriptHash: Sha256
  @prop(true) owner: PubKey
  /** Tip: owner's delayed proof. Proof: token spent by its creating Commit. */
  @prop(true) linkOutpoint: ByteString
  /** Externally BRC-150-verified legacy tip spent by genesis. */
  @prop() legacyTipOutpoint: ByteString

  constructor(
    role: bigint,
    origin: ByteString,
    originScriptHash: Sha256,
    owner: PubKey,
    linkOutpoint: ByteString,
    legacyTipOutpoint: ByteString,
  ) {
    super(...arguments)
    this.role = role
    this.origin = origin
    this.originScriptHash = originScriptHash
    this.owner = owner
    this.linkOutpoint = linkOutpoint
    this.legacyTipOutpoint = legacyTipOutpoint
  }

  /** Tx1/Tx3: retain token, create next recipient's delayed proof at vout1. */
  @method()
  public commit(sig: Sig, nextProofScript: ByteString) {
    assert(this.checkSig(sig, this.owner), 'bad owner sig')
    assert(this.role == Brc156Covenant.ROLE_TIP, 'commit requires tip')
    assert(this.ctx.utxo.value == Brc156Covenant.TIP_SATS, 'tip must be 1 sat')
    const self = this.ctx.utxo.outpoint.txid +
      int2ByteString(this.ctx.utxo.outpoint.outputIndex, 4n)
    assert(slice(this.prevouts, 0n, 36n) == self, 'tip must be vin0')
    let outputs = this.buildStateOutput(Brc156Covenant.TIP_SATS)
    outputs += Utils.buildOutput(nextProofScript, Brc156Covenant.PROOF_SATS)
    outputs += this.buildChangeOutput()
    assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
  }

  /** Tx2 base case: Tx0 must directly spend the verified legacy tip. */
  @method()
  public settleBase(
    sig: Sig,
    newOwner: PubKey,
    commitTx: ByteString,
    genesisTx: ByteString,
  ) {
    assert(this.checkSig(sig, this.owner), 'bad owner sig')
    assert(this.role == Brc156Covenant.ROLE_TIP, 'settleBase requires tip')
    assert(
      this.linkOutpoint == toByteString(
        '000000000000000000000000000000000000000000000000000000000000000000000000',
      ),
      'not base token',
    )
    this.assertCanonicalTx(commitTx)
    this.assertCanonicalTx(genesisTx)
    assert(hash256(commitTx) == this.ctx.utxo.outpoint.txid, 'commit txid mismatch')
    const genesisToken = slice(commitTx, 5n, 41n)
    assert(hash256(genesisTx) == slice(genesisToken, 0n, 32n), 'genesis txid mismatch')
    assert(
      slice(genesisTx, 5n, 41n) == this.legacyTipOutpoint,
      'genesis did not spend verified legacy tip',
    )
    this.linkOutpoint = this.ctx.utxo.outpoint.txid + int2ByteString(1n, 4n)
    this.owner = newOwner
    let outputs = this.buildStateOutput(Brc156Covenant.TIP_SATS)
    outputs += Utils.buildAddressOutput(pubKey2Addr(newOwner), Brc156Covenant.BEACON_SATS)
    outputs += this.buildChangeOutput()
    assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
  }

  /** Tx4/Tx6: consume Tx3 token plus delayed proof from Tx1; rebuild Tx3→Tx2→Tx1. */
  @method()
  public settle(
    sig: Sig,
    newOwner: PubKey,
    currentCommitTx: ByteString,
    priorSettleTx: ByteString,
    proofCommitTx: ByteString,
  ) {
    assert(this.checkSig(sig, this.owner), 'bad owner sig')
    assert(this.role == Brc156Covenant.ROLE_TIP, 'settle requires tip')
    this.assertCanonicalTx(currentCommitTx)
    this.assertCanonicalTx(priorSettleTx)
    this.assertCanonicalTx(proofCommitTx)
    const self = this.ctx.utxo.outpoint.txid +
      int2ByteString(this.ctx.utxo.outpoint.outputIndex, 4n)
    assert(slice(this.prevouts, 0n, 36n) == self, 'tip must be vin0')
    assert(slice(this.prevouts, 36n, 72n) == this.linkOutpoint,
      'must consume delayed prior proof at vin1')
    assert(hash256(currentCommitTx) == this.ctx.utxo.outpoint.txid,
      'current commit txid mismatch')
    const priorToken = slice(currentCommitTx, 5n, 41n)
    assert(hash256(priorSettleTx) == slice(priorToken, 0n, 32n),
      'prior settle txid mismatch')
    const proofToken = slice(priorSettleTx, 5n, 41n)
    assert(slice(proofToken, 0n, 32n) == slice(this.linkOutpoint, 0n, 32n),
      'prior settle is not linked to delayed proof commit')
    assert(slice(proofToken, 32n, 36n) == int2ByteString(0n, 4n),
      'prior settle must spend proof-commit token vout0')
    assert(slice(this.linkOutpoint, 32n, 36n) == int2ByteString(1n, 4n),
      'delayed proof must be proof-commit vout1')
    assert(hash256(proofCommitTx) == slice(this.linkOutpoint, 0n, 32n),
      'proof commit txid mismatch')
    this.linkOutpoint = this.ctx.utxo.outpoint.txid + int2ByteString(1n, 4n)
    this.owner = newOwner
    let outputs = this.buildStateOutput(Brc156Covenant.TIP_SATS)
    outputs += Utils.buildAddressOutput(pubKey2Addr(newOwner), Brc156Covenant.BEACON_SATS)
    outputs += this.buildChangeOutput()
    assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
  }

  /** Delayed proof half of the same Tx4/Tx6 co-spend. */
  @method()
  public settleProof(
    sig: Sig,
    newOwner: PubKey,
    nextTipScript: ByteString,
    currentCommitTx: ByteString,
    priorSettleTx: ByteString,
    proofCommitTx: ByteString,
  ) {
    assert(this.checkSig(sig, this.owner), 'bad proof owner sig')
    assert(this.role == Brc156Covenant.ROLE_PROOF, 'requires proof')
    assert(this.ctx.utxo.value == Brc156Covenant.PROOF_SATS, 'proof must be 3 sats')
    const self = this.ctx.utxo.outpoint.txid +
      int2ByteString(this.ctx.utxo.outpoint.outputIndex, 4n)
    assert(slice(this.prevouts, 36n, 72n) == self, 'proof must be vin1')
    assert(hash256(proofCommitTx) == this.ctx.utxo.outpoint.txid,
      'proof source txid mismatch')
    assert(slice(proofCommitTx, 5n, 41n) == this.linkOutpoint,
      'proof commit token mismatch')
    assert(hash256(currentCommitTx) == slice(this.prevouts, 0n, 32n),
      'current commit/input mismatch')
    const priorToken = slice(currentCommitTx, 5n, 41n)
    assert(hash256(priorSettleTx) == slice(priorToken, 0n, 32n),
      'prior settle mismatch')
    const proofToken = slice(priorSettleTx, 5n, 41n)
    assert(slice(proofToken, 0n, 32n) == this.ctx.utxo.outpoint.txid,
      'proof does not latch prior settle')
    let outputs = Utils.buildOutput(nextTipScript, Brc156Covenant.TIP_SATS)
    outputs += Utils.buildAddressOutput(pubKey2Addr(newOwner), Brc156Covenant.BEACON_SATS)
    outputs += this.buildChangeOutput()
    assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
  }

  @method()
  private assertCanonicalTx(tx: ByteString): void {
    assert(len(tx) > 41n, 'transaction too short')
    assert(
      slice(tx, 4n, 5n) == toByteString('01') ||
      slice(tx, 4n, 5n) == toByteString('02') ||
      slice(tx, 4n, 5n) == toByteString('03'),
      'input count outside profile',
    )
  }
}

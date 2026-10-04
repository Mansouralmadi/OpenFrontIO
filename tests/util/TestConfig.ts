import {
  AttackLogicInput,
  AttackLogicResult,
  Config,
  NukeMagnitude,
} from "../../src/core/configuration/Config";
import { Gold, Player, Tick, UnitType } from "../../src/core/game/Game";

export class TestConfig extends Config {
  private _proximityBonusPortsNb: number = 0;
  private _defaultNukeSpeed: number = 4;
  private _spawnImmunityDuration: number = 0;
  private _nationSpawnImmunityDuration: number = 0;
  private _allianceGoldCost: boolean = false;

  // Alliances are free in tests (as spawn immunity is off) unless a test
  // opts in, so tests that just need an alliance don't have to fund it.
  enableAllianceGoldCost(): void {
    this._allianceGoldCost = true;
  }

  allianceGoldCost(player: Player): Gold {
    return this._allianceGoldCost ? super.allianceGoldCost(player) : 0n;
  }

  disableNavMesh(): boolean {
    return this.gameConfig().disableNavMesh ?? true;
  }

  radiusPortSpawn(): number {
    return 1;
  }

  proximityBonusPortsNb(totalPorts: number): number {
    return this._proximityBonusPortsNb;
  }

  // Specific to TestConfig
  setProximityBonusPortsNb(nb: number): void {
    this._proximityBonusPortsNb = nb;
  }

  nukeMagnitudes(_: UnitType): NukeMagnitude {
    return { inner: 1, outer: 1 };
  }

  setDefaultNukeSpeed(speed: number): void {
    this._defaultNukeSpeed = speed;
  }

  // Flat speed for all nuke types so test tick counts stay predictable.
  nukeSpeed(_: UnitType): number {
    return this._defaultNukeSpeed;
  }

  defaultNukeTargetableRange(): number {
    return 20;
  }

  deletionMarkDuration(): number {
    return 5;
  }

  defaultSamRange(): number {
    return 20;
  }

  samRange(level: number): number {
    return 20;
  }

  setSpawnImmunityDuration(duration: Tick) {
    this._spawnImmunityDuration = duration;
  }

  spawnImmunityDuration(): Tick {
    return this._spawnImmunityDuration;
  }

  setNationSpawnImmunityDuration(duration: Tick) {
    this._nationSpawnImmunityDuration = duration;
  }

  nationSpawnImmunityDuration(): Tick {
    return this._nationSpawnImmunityDuration;
  }

  attackLogic(_input: AttackLogicInput): AttackLogicResult {
    return { attackerTroopLoss: 1, defenderTroopLoss: 1, tickFraction: 1 };
  }
}
export class UseRealAttackLogic extends TestConfig {
  attackLogic(input: AttackLogicInput): AttackLogicResult {
    return Config.prototype.attackLogic.call(this, input);
  }
}

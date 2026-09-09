import type { DistrictId } from './types'

export interface Destination {
  district: Exclude<DistrictId, 'world'>
  id: string
  name: string
  /** Obvious abbreviation for the 196 px minimap only. */
  shortName: string
}

/**
 * The eight places a visitor can navigate to.
 *
 * View controls, help, floating map labels, ground wayfinding, the minimap and
 * destination inspector headings all read this table. Component names remain
 * free to name the specific building at the destination.
 */
export const DESTINATIONS: readonly Destination[] = [
  { district: 'clients', id: 'client.pool', name: 'Host clients', shortName: 'Hosts' },
  { district: 'backends', id: 'backend.row', name: 'Flow towers (SQ/CQ pairs)', shortName: 'Flows' },
  {
    district: 'shmem',
    id: 'shared.buffers',
    name: 'Device DRAM data cache',
    shortName: 'DRAM cache',
  },
  { district: 'wal', id: 'wal.vault', name: 'Write path (destage)', shortName: 'Destage' },
  { district: 'storage', id: 'storage.datadir', name: 'NAND array', shortName: 'NAND' },
  { district: 'planner', id: 'planner.lab', name: 'FTL lab', shortName: 'FTL' },
  { district: 'maintenance', id: 'checkpointer', name: 'Garbage collection', shortName: 'GC' },
  { district: 'replication', id: 'replica.standby', name: 'Multi-queue fairness', shortName: 'Fairness' },
] as const

const BY_DISTRICT = new Map<DistrictId, Destination>(
  DESTINATIONS.map((destination) => [destination.district, destination]),
)
const BY_ID = new Map(DESTINATIONS.map((destination) => [destination.id, destination]))

export function destinationForDistrict(district: DistrictId): Destination | undefined {
  return BY_DISTRICT.get(district)
}

export function destinationForId(id: string): Destination | undefined {
  return BY_ID.get(id)
}

import { LOCATIONS, DEFAULT_LOCATION } from "../calc/solar";
export const DEFAULT_STATE = {
    peakKWp: 22,
    tiltDeg: 35,
    orientation: "south",
    location: DEFAULT_LOCATION,
    capacityKWh: 19.353,
    maxPowerKW: 6,
    minSOC: 0.1,
    maxSOC: 0.95,
    efficiency: 0.95,
    startSOC: 0.5,
    chargeMode: "solar",
    dischargeEvening: true,
    dischargeMorning: true,
    eveningStart: 17,
    eveningEnd: 23,
    morningStart: 5,
    morningEnd: 12,
    feedInCt: 7.2,
    premiumCt: 1.5,
};
export function toSimConfig(s) {
    const hasBattery = s.capacityKWh > 0;
    return {
        pv: {
            peakKWp: s.peakKWp,
            tiltDeg: s.tiltDeg,
            orientation: s.orientation,
            location: s.location in LOCATIONS ? s.location : DEFAULT_LOCATION,
        },
        battery: {
            capacityKWh: s.capacityKWh,
            maxPowerKW: s.maxPowerKW,
            minSOC: s.minSOC,
            maxSOC: s.maxSOC,
            efficiency: s.efficiency,
            startSOC: s.startSOC,
            chargeMode: s.chargeMode,
            dischargeEvening: hasBattery && s.dischargeEvening,
            dischargeMorning: hasBattery && s.dischargeMorning,
            eveningStart: s.eveningStart,
            eveningEnd: s.eveningEnd,
            morningStart: s.morningStart,
            morningEnd: s.morningEnd,
        },
        tariff: {
            feedInEUR: s.feedInCt / 100,
            marketPremiumEUR: s.premiumCt / 100,
        },
    };
}

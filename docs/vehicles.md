# Vehicles (idea notes, not a plan)

Stashed from a design chat with Knarfy, Nov 11 2026. Nothing here is approved or scheduled.

## What a vehicle is
- Car-or-larger vehicles with real, walkable interiors that can host scenes (a starship, a train, a caravan).
- Its own class of area ("vehicle"), reusing the region/subregion code, so later features (vehicle combat, damage, fuel) have somewhere to hang.
- The interior never changes when it moves. What changes is what's outside and where its outside exits lead.
- Vehicles can nest: a speeder parked inside a freighter is just a dock that sits inside another vehicle.

## Outside exits and "what's outside"
- The vehicle marks which exits face outside (ramp, airlock, car door).
- Docked: the outside exit connects to the dock it's at; the dock gets a matching exit back.
- In transit: the outside exit is closed and the vehicle carries a "what's outside" description (on the road, in hyperspace, in orbit). Viewports read from it.
- Moving is a message stamp like every other change, so Undo / Turn off work as usual.

## Docks
- Specific tagged locations, like regional start locations.
- Free-text kind tags defined by the world, not the engine: a suburban drama has `parking space`; a space opera has `landing pad frigate`, `airlock capital`.
- Vehicle outside exits carry a matching pattern, with `{a|b}` for either: `airlock {frigate|capital}`. The engine only matches words; size classes are just more words.

## Travel networks
- Travel modes belong to named networks (Corellia roads, hyperspace lanes). A dock lists which networks it's on.
- A vehicle can only reach docks on the same network it departed from, so you can't drive a ground car between planets.
- Travel time lives on the network: a network is basically a graph of exits between docks, each link with its own time and the vehicles it allows.
- Possibly the same mechanism as "node" exits for on-foot travel (a link you travel along with a cost).
- Keep it as a plain time per link for now. Full geographic hex maps could later compute those times from distance without changing the rest.

## Making a move
- Started in the story (e.g. `[fly to …]`, or the narrator flagging it), but only from a room the vehicle marks as a control room (cockpit, driver's seat). Refused elsewhere.
- Departing does not just time-skip. It disconnects the vehicle from the departure dock and puts it in transit, with a destination and arrival time.
- You can play scenes in transit, or wait to arrive immediately.
- Arrival is a flip like schedule arrivals: the outside exit connects to the destination dock, with a narrator notice. Effects that expire on the way get narrated like any other wait.
- Destinations follow discovery rules: only places the party knows about (or everything with Reveal map on).

## Open questions
- People aboard: schedules need "aboard <vehicle>" as a location that moves with it.
- Do NPC-driven vehicles (a bus, a ferry) run on schedules like people?
- Docks that are full or occupied by another vehicle.

// The page's group logic. It runs in the browser, but needs nothing from it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGroups, groupOf, withGroupMoved, withGroupShifted, withRouteMoved } from '../public/groups.js';

const GROUPS = [
  { name: 'Media', routes: ['jellyfin', 'sonarr'] },
  { name: 'Tools', routes: ['grafana'] },
  { name: 'Home', routes: [] },
];

const names = groups => groups.map(group => group.name);

describe('groupOf', () => {
  it('finds the group a route is in', () => {
    assert.equal(groupOf(GROUPS, 'grafana').name, 'Tools');
  });

  it('is undefined for a route in no group', () => {
    assert.equal(groupOf(GROUPS, 'traefik'), undefined);
  });
});

describe('withRouteMoved', () => {
  it('moves a route from its group to the end of another', () => {
    const moved = withRouteMoved(GROUPS, 'sonarr', 'Tools');
    assert.deepEqual(moved.map(group => group.routes), [['jellyfin'], ['grafana', 'sonarr'], []]);
  });

  it('puts the route in front of the one it was dropped on', () => {
    const moved = withRouteMoved(GROUPS, 'grafana', 'Media', 'sonarr');
    assert.deepEqual(moved[0].routes, ['jellyfin', 'grafana', 'sonarr']);
  });

  it('reorders a route within its own group', () => {
    const moved = withRouteMoved(GROUPS, 'sonarr', 'Media', 'jellyfin');
    assert.deepEqual(moved[0].routes, ['sonarr', 'jellyfin']);
  });

  it('takes the route out of every group when there is no target', () => {
    const moved = withRouteMoved(GROUPS, 'grafana', null);
    assert.equal(groupOf(moved, 'grafana'), undefined);
  });

  it('leaves the groups it was given alone', () => {
    withRouteMoved(GROUPS, 'sonarr', 'Tools');
    assert.deepEqual(GROUPS[1].routes, ['grafana']);
  });
});

describe('withGroupMoved', () => {
  it('puts a group in front of another', () => {
    assert.deepEqual(names(withGroupMoved(GROUPS, 'Home', 'Media')), ['Home', 'Media', 'Tools']);
  });

  it('puts a group last when there is no group to go in front of', () => {
    assert.deepEqual(names(withGroupMoved(GROUPS, 'Media', null)), ['Tools', 'Home', 'Media']);
  });

  it('changes nothing for a group that does not exist', () => {
    assert.equal(withGroupMoved(GROUPS, 'Games', 'Media'), GROUPS);
  });
});

describe('withGroupShifted', () => {
  const cases = [
    ['moves a group up one place', 'Tools', -1, ['Tools', 'Media', 'Home']],
    ['moves a group down one place', 'Tools', 1, ['Media', 'Home', 'Tools']],
    ['leaves the top group where it is when moved up', 'Media', -1, ['Media', 'Tools', 'Home']],
    ['leaves the bottom group where it is when moved down', 'Home', 1, ['Media', 'Tools', 'Home']],
  ];
  for (const [name, group, step, expected] of cases) {
    it(name, () => {
      assert.deepEqual(names(withGroupShifted(GROUPS, group, step)), expected);
    });
  }
});

// A server whose replies the test settles by hand, one save at a time, in any order.
function fakeServer() {
  const pending = [];
  return {
    pending,
    put: groups => new Promise((resolve, reject) => pending.push({ groups, resolve: () => resolve(groups), reject })),
  };
}

function groupsWith(server, { reload = async () => {} } = {}) {
  const renders = [];
  const groups = createGroups({ put: server.put, onChange: () => renders.push(groups.list), reload });
  return { groups, renders };
}

const ONE = [{ name: 'Media', routes: [] }];
const TWO = [{ name: 'Media', routes: [] }, { name: 'Tools', routes: [] }];

describe('createGroups save', () => {
  it('shows a change before the server has it', () => {
    const server = fakeServer();
    const { groups, renders } = groupsWith(server);
    groups.save(ONE);
    assert.deepEqual(renders, [ONE]);
  });

  it('keeps the change once the server saves it', async () => {
    const server = fakeServer();
    const { groups } = groupsWith(server);
    const saved = groups.save(ONE);
    server.pending[0].resolve();
    await saved;
    assert.deepEqual(groups.list, ONE);
  });

  it('does not send a change that leaves the groups as they are', async () => {
    const server = fakeServer();
    const { groups } = groupsWith(server);
    await groups.save([]);
    assert.equal(server.pending.length, 0);
  });

  it('goes back to the groups the server last confirmed when it refuses a change', async () => {
    const server = fakeServer();
    const { groups } = groupsWith(server);
    const first = groups.save(ONE);
    server.pending[0].resolve();
    await first;
    const second = groups.save(TWO);
    server.pending[1].reject(new Error('disk full'));
    await second;
    assert.deepEqual(groups.list, ONE);
  });

  it('says why a change was not saved', async () => {
    const server = fakeServer();
    const { groups } = groupsWith(server);
    const saved = groups.save(ONE);
    server.pending[0].reject(new Error('disk full'));
    await saved;
    assert.equal(groups.error, 'disk full');
  });

  it('reloads the groups when a change is refused', async () => {
    const server = fakeServer();
    let reloads = 0;
    const { groups } = groupsWith(server, { reload: async () => { reloads++; } });
    const saved = groups.save(ONE);
    server.pending[0].reject(new Error('disk full'));
    await saved;
    assert.equal(reloads, 1);
  });

  it('keeps a newer change when an earlier save finishes first', async () => {
    const server = fakeServer();
    const { groups } = groupsWith(server);
    const first = groups.save(ONE);
    const second = groups.save(TWO);
    server.pending[0].resolve();
    await first;
    assert.deepEqual(groups.list, TWO);
    server.pending[1].resolve();
    await second;
  });

  it('does not undo a newer change that is still saving when an earlier save is refused', async () => {
    const server = fakeServer();
    const { groups } = groupsWith(server);
    const first = groups.save(ONE);
    const second = groups.save(TWO);
    server.pending[0].reject(new Error('disk full'));
    await first;
    assert.deepEqual(groups.list, TWO);
    server.pending[1].resolve();
    await second;
  });

  it('clears an earlier error once a later save has everything', async () => {
    const server = fakeServer();
    const { groups } = groupsWith(server);
    const first = groups.save(ONE);
    const second = groups.save(TWO);
    server.pending[0].reject(new Error('disk full'));
    await first;
    server.pending[1].resolve();
    await second;
    assert.equal(groups.error, null);
  });
});

describe('createGroups startLoad', () => {
  it('shows the groups a load brought back', () => {
    const { groups } = groupsWith(fakeServer());
    const apply = groups.startLoad();
    apply(ONE);
    assert.deepEqual(groups.list, ONE);
  });

  it('ignores a load that started before a change, which may predate it', async () => {
    const server = fakeServer();
    const { groups } = groupsWith(server);
    const apply = groups.startLoad();
    const saved = groups.save(TWO);
    server.pending[0].resolve();
    await saved;
    apply(ONE);
    assert.deepEqual(groups.list, TWO);
  });

  it('ignores a load that comes back while a change is saving', () => {
    const server = fakeServer();
    const { groups } = groupsWith(server);
    groups.save(TWO);
    const apply = groups.startLoad();
    apply(ONE);
    assert.deepEqual(groups.list, TWO);
  });

  it('falls back to the loaded groups when a later change is refused', async () => {
    const server = fakeServer();
    const { groups } = groupsWith(server);
    groups.startLoad()(ONE);
    const saved = groups.save(TWO);
    server.pending[0].reject(new Error('disk full'));
    await saved;
    assert.deepEqual(groups.list, ONE);
  });
});

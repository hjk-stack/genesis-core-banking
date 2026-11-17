import unittest
from runtime_settings import configure_runtime_robots


class FakeStrategy:
    def __init__(self, settings):
        self.settings = settings
        self.ticks = ['retained market observation']
        self.index = {'sequence': 'retained index'}
        self.position = 4
        self.pending = True
        self.stop = 91
        self.peak = 105


class RuntimeWalletSelectionTests(unittest.TestCase):
    def test_two_coins_activate_and_pause_independently_without_version_change(self):
        robots = {}
        configure_runtime_robots(robots, [
            {'id': 'ag', 'version': 7, 'enabled': False},
            {'id': 'agi', 'version': 7, 'enabled': False}], FakeStrategy)
        original_ag, original_agi = robots['ag'], robots['agi']
        configure_runtime_robots(robots, [
            {'id': 'ag', 'version': 7, 'enabled': True},
            {'id': 'agi', 'version': 7, 'enabled': True}], FakeStrategy)
        self.assertTrue(robots['ag'].settings['enabled'])
        self.assertTrue(robots['agi'].settings['enabled'])
        configure_runtime_robots(robots, [
            {'id': 'ag', 'version': 7, 'enabled': False},
            {'id': 'agi', 'version': 7, 'enabled': True}], FakeStrategy)
        self.assertFalse(robots['ag'].settings['enabled'])
        self.assertTrue(robots['agi'].settings['enabled'])
        self.assertIs(robots['ag'], original_ag)
        self.assertIs(robots['agi'], original_agi)

    def test_pause_preserves_open_positions_pending_orders_and_observations(self):
        robots = {}
        configure_runtime_robots(robots, [{'id': 'ag', 'version': 2, 'enabled': True}], FakeStrategy)
        old = robots['ag']
        ticks, index = old.ticks, old.index
        configure_runtime_robots(robots, [{'id': 'ag', 'version': 2, 'enabled': False}], FakeStrategy)
        self.assertIs(robots['ag'], old)
        self.assertIs(old.ticks, ticks)
        self.assertIs(old.index, index)
        self.assertEqual((old.position, old.pending, old.stop, old.peak), (4, True, 91, 105))
        self.assertFalse(old.settings['enabled'])

    def test_only_explicit_true_grants_effective_entry_permission(self):
        robots = {}
        for permission in [False, None, 'true', 'false', 1, 0]:
            configure_runtime_robots(robots, [{'id': 'ag', 'version': 1, 'enabled': permission}], FakeStrategy)
            self.assertIs(robots['ag'].settings['enabled'], False)
        configure_runtime_robots(robots, [{'id': 'ag', 'version': 1, 'enabled': True}], FakeStrategy)
        self.assertIs(robots['ag'].settings['enabled'], True)
        configure_runtime_robots(robots, [{'id': 'ag', 'version': 1}], FakeStrategy)
        self.assertIs(robots['ag'].settings['enabled'], False)

    def test_new_strategy_version_and_removed_profiles_keep_existing_semantics(self):
        robots = {}
        config = [{'id': 'ag', 'version': 1, 'enabled': True},
                  {'id': 'agi', 'version': 1, 'enabled': True}]
        configure_runtime_robots(robots, config, FakeStrategy)
        old = robots['ag']
        self.assertIsNot(robots['ag'].settings, config[0])
        configure_runtime_robots(robots, [{'id': 'ag', 'version': 2, 'enabled': False}], FakeStrategy)
        self.assertNotIn('agi', robots)
        self.assertIsNot(robots['ag'], old)
        self.assertEqual(robots['ag'].settings['version'], 2)
        self.assertFalse(robots['ag'].settings['enabled'])


if __name__ == '__main__':
    unittest.main()

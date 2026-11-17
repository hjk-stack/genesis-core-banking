"""Apply server-authorised runtime controls without resetting strategy history."""


def configure_runtime_robots(robots, settings, strategy_factory):
    """Rebuild changed strategies, but refresh coin permission on every CONFIG.

    Wallet selections change independently of the saved strategy version. Only
    the effective entry permission is mutable here; market observations, open
    position management, pending orders and INDEX state remain on the instance.
    """
    keep = {item['id'] for item in settings}
    for robot_id in set(robots) - keep:
        del robots[robot_id]
    for item in settings:
        old = robots.get(item['id'])
        if old is None or old.settings.get('version') != item.get('version'):
            # Copy to avoid retaining caller-owned mutable configuration.
            robots[item['id']] = strategy_factory({**item, 'enabled': item.get('enabled') is True})
        else:
            old.settings['enabled'] = item.get('enabled') is True

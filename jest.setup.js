// @expo/vector-icons' Icon checks Font.isLoaded() on init; when it returns false
// (as it does under the jest-expo native mocks) the icon schedules an async
// Font.loadAsync().then(setState) in componentDidMount that resolves after the
// synchronous test body finishes, producing "update not wrapped in act(...)"
// warnings. Reporting fonts as already loaded makes icons render synchronously
// and removes that late state update.
jest.mock('expo-font', () => ({
  ...jest.requireActual('expo-font'),
  isLoaded: () => true,
  loadAsync: () => Promise.resolve(),
}));

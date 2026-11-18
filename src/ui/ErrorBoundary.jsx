import { Component } from 'react';

// Last line of defence: an unexpected UI error shows a readable message and a
// reload button instead of a blank page.
export class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Primal UI error', error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fatal" role="alert">
        <h2>Something went wrong.</h2>
        <p>The demo hit an unexpected error. Reloading usually fixes it.</p>
        <button type="button" onClick={() => location.reload()}>RELOAD</button>
      </div>
    );
  }
}

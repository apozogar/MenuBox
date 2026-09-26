import { Component, OnInit, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Router } from '@angular/router';
import { AuthService, Menu, User } from './services/auth.service';
import { ToastService } from './services/toast.service';
import { ConfirmService } from './services/confirm.service';
import { ToastContainer } from './components/toast-container/toast-container';
import { ConfirmModal } from './components/confirm-modal/confirm-modal';

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule, RouterModule, ToastContainer, ConfirmModal],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  user: User | null = null;
  menus: Menu[] = [];
  currentMenuId = 1;
  isDark = false;

  baseNavItems = [
    { path: '/', label: 'Calendario', icon: '📅' },
    { path: '/recipes', label: 'Recetas', icon: '📖' },
    { path: '/shopping-list', label: 'Compra', icon: '🛒' },
    { path: '/settings', label: 'Ajustes', icon: '⚙️' },
  ];

  get navItems() {
    if (this.user?.isSuperadmin) {
      return [...this.baseNavItems, { path: '/admin/activity', label: 'Actividad', icon: '🕵️' }];
    }
    return this.baseNavItems;
  }

  showMenuDropdown = false;
  showMenuModal = false;
  menuModalMode: 'create' | 'rename' = 'create';
  menuModalName = '';
  menuModalLoading = false;
  editingMenu: Menu | null = null;

  showShareModal = false;
  shareUsername = '';
  shareLoading = false;
  shareError = '';
  shareUsers: { id: number; username: string; email: string; role: string }[] = [];
  shareLoadingUsers = false;

  constructor(
    private auth: AuthService,
    private router: Router,
    private toast: ToastService,
    private confirm: ConfirmService,
  ) {}

  ngOnInit() {
    this.isDark = localStorage.getItem('theme') === 'dark';
    this.applyTheme();
    this.auth.user$.subscribe(u => {
      this.user = u;
    });
    this.auth.menus$.subscribe(m => {
      this.menus = m;
    });
    let menuInit = true;
    this.auth.currentMenuId$.subscribe(id => {
      this.currentMenuId = id;
      if (!menuInit) {
        setTimeout(() => {
          const el = document.querySelector('.main-content');
          if (el) el.scrollTop = 0;
        });
      }
      menuInit = false;
    });
    if (this.auth.isLoggedIn()) {
      this.auth.loadMenus();
    }
  }

  get currentMenuName(): string {
    return this.menus.find(m => m.id === this.currentMenuId)?.name ?? 'Seleccionar menú';
  }

  selectMenu(menuId: number) {
    this.auth.setCurrentMenu(menuId);
    this.showMenuDropdown = false;
  }

  toggleMenuDropdown() {
    this.showMenuDropdown = !this.showMenuDropdown;
  }

  closeMenuDropdown() {
    this.showMenuDropdown = false;
  }

  openCreateMenu() {
    this.menuModalMode = 'create';
    this.menuModalName = '';
    this.editingMenu = null;
    this.showMenuModal = true;
    this.showMenuDropdown = false;
  }

  openRenameMenu(menu: Menu, event: Event) {
    event.stopPropagation();
    this.menuModalMode = 'rename';
    this.menuModalName = menu.name;
    this.editingMenu = menu;
    this.showMenuModal = true;
    this.showMenuDropdown = false;
  }

  closeMenuModal() {
    this.showMenuModal = false;
    this.menuModalLoading = false;
  }

  async confirmMenuAction() {
    const name = this.menuModalName.trim();
    if (!name || this.menuModalLoading) return;
    this.menuModalLoading = true;
    if (this.menuModalMode === 'create') {
      await this.auth.createMenu(name);
    } else if (this.menuModalMode === 'rename' && this.editingMenu) {
      await this.auth.renameMenu(this.editingMenu.id, name);
    }
    this.showMenuModal = false;
    this.menuModalLoading = false;
  }

  async deleteMenu(menu: Menu, event: Event) {
    event.stopPropagation();
    const ok = await this.confirm.confirm(`¿Eliminar "${menu.name}"?`);
    if (!ok) return;
    await this.auth.deleteMenu(menu.id);
  }

  openShareModal(menu: Menu, event: Event) {
    event.stopPropagation();
    this.shareUsername = '';
    this.shareError = '';
    this.shareUsers = [];
    this.editingMenu = menu;
    this.showShareModal = true;
    this.showMenuDropdown = false;
    this.loadShareUsers();
  }

  closeShareModal() {
    this.showShareModal = false;
    this.shareLoading = false;
  }

  async loadShareUsers() {
    if (!this.editingMenu) return;
    this.shareLoadingUsers = true;
    this.shareUsers = await this.auth.getMenuUsers(this.editingMenu.id);
    this.shareLoadingUsers = false;
  }

  async shareMenu() {
    const name = this.shareUsername.trim();
    if (!name || this.shareLoading || !this.editingMenu) return;
    this.shareLoading = true;
    this.shareError = '';
    const result = await this.auth.shareMenu(this.editingMenu.id, name);
    if (result.ok) {
      this.shareUsername = '';
      await this.loadShareUsers();
    } else {
      this.shareError = result.error || 'Error al compartir';
    }
    this.shareLoading = false;
  }

  async removeShareUser(userId: number) {
    if (!this.editingMenu) return;
    const ok = await this.confirm.confirm('¿Quitar acceso a este usuario?');
    if (!ok) return;
    await this.auth.removeMenuUser(this.editingMenu.id, userId);
    await this.loadShareUsers();
  }

  async cloneMenu(menu: Menu, event: Event) {
    event.stopPropagation();
    this.showMenuDropdown = false;
    const ok = await this.confirm.confirm(`¿Clonar "${menu.name}"? Se copiarán recetas, ingredientes y calendario.`);
    if (!ok) return;
    const result = await this.auth.cloneMenu(menu.id, menu.name + ' (copia)');
    if (result.ok) {
      this.toast.success('Menú clonado correctamente');
    } else {
      this.toast.error(result.error || 'Error al clonar');
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (!this.showMenuDropdown) return;
    const target = event.target as HTMLElement;
    if (!target.closest('.menu-dropdown')) {
      this.showMenuDropdown = false;
    }
  }

  logout() {
    this.auth.logout();
  }

  toggleDarkMode() {
    this.isDark = !this.isDark;
    localStorage.setItem('theme', this.isDark ? 'dark' : 'light');
    this.applyTheme();
  }

  private applyTheme() {
    document.documentElement.setAttribute('data-theme', this.isDark ? 'dark' : 'light');
  }

  isLoginPage(): boolean {
    return this.router.url === '/login';
  }

  isActive(path: string): boolean {
    if (path === '/') {
      return this.router.url === '/' || this.router.url === '';
    }
    return this.router.url.startsWith(path);
  }
}